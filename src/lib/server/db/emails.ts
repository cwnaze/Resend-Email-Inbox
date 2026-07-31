// Drizzle query helpers for the `emails` and `threads` tables (US-E03).
//
// Same shape as `contacts.ts` / `src/lib/server/auth/*.ts`: the db handle is the
// first argument (typed via `Database` from `./types`) rather than importing the
// `db` singleton, so this module never pulls in `$env/dynamic/private` and can
// be exercised by a standalone `tsx` verification script.
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { emails, threads } from './schema';
import type { Database } from './types';

export type Email = typeof emails.$inferSelect;
export type Thread = typeof threads.$inferSelect;

export type NewInboundEmail = {
	threadId: string;
	messageId: string;
	inReplyTo: string | null;
	fromEmail: string;
	fromName: string | null;
	toEmails: string[];
	ccEmails: string[];
	bccEmails: string[];
	subject: string;
	bodyText: string | null;
	/** Must already be sanitized — see `inbound/sanitize.ts`. */
	bodyHtml: string | null;
	receivedAt: Date;
};

/**
 * An email this app sent (US-H02). Distinct from `NewInboundEmail` in the three
 * ways that matter: there is no `fromName`/`receivedAt` to take from a provider
 * (the sender is this app and the timestamp is "now"), `bodyText` is required
 * while `bodyHtml` is the optional one (the inverse of inbound mail, because the
 * compose screen produces plain text), and it is `isRead` on arrival — the owner
 * wrote it.
 */
export type NewOutboundEmail = {
	threadId: string;
	messageId: string;
	inReplyTo: string | null;
	fromEmail: string;
	toEmails: string[];
	ccEmails: string[];
	subject: string;
	bodyText: string;
	/** Must already be sanitized if present — see `inbound/sanitize.ts`. */
	bodyHtml: string | null;
	/** Doubles as the inbox sort key, exactly as `receivedAt` does inbound. */
	sentAt: Date;
};

export async function getEmailByMessageId(
	db: Database,
	messageId: string
): Promise<Email | undefined> {
	const [row] = await db.select().from(emails).where(eq(emails.messageId, messageId)).limit(1);
	return row;
}

/**
 * One visible email by its primary key — the message a reply is answering
 * (US-H03).
 *
 * Soft-deleted rows are excluded, matching `listThreadEmails`'s definition of
 * "visible": the reply link is rendered from that list, so a `?replyTo=` id
 * naming a deleted message can only come from a stale tab, and quoting a
 * message the owner has already removed from the thread would resurrect its
 * text into a new send.
 */
export async function getVisibleEmailById(
	db: Database,
	emailId: string
): Promise<Email | undefined> {
	const [row] = await db
		.select()
		.from(emails)
		.where(and(eq(emails.id, emailId), eq(emails.isDeleted, false)))
		.limit(1);
	return row;
}

export async function getThreadById(db: Database, threadId: string): Promise<Thread | undefined> {
	const [row] = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
	return row;
}

/**
 * Every visible message in a thread, oldest first (US-G01, FR-1).
 *
 * Soft-deleted emails are excluded here rather than filtered out in the load,
 * which is what makes "the thread has no visible messages" a `length === 0`
 * answer the page can 404 on — the same definition of "visible email" the inbox
 * list's inner join uses.
 *
 * `id` breaks a tie on `received_at`: the sort key is a sender-supplied `Date:`
 * header, so two messages can legitimately carry the same millisecond, and
 * without the tie-breaker their order could flip between loads. Ascending on
 * both, mirroring the descending pair `listInboxThreads` picks the newest with.
 */
export async function listThreadEmails(db: Database, threadId: string): Promise<Email[]> {
	return db
		.select()
		.from(emails)
		.where(and(eq(emails.threadId, threadId), eq(emails.isDeleted, false)))
		.orderBy(asc(emails.receivedAt), asc(emails.id));
}

export type InsertInboundEmailResult = {
	email: Email;
	/** False when this exact `message_id` was already stored (a redelivery). */
	created: boolean;
};

/**
 * Inserts an inbound email, idempotently on `message_id` (FR-2).
 *
 * `onConflictDoNothing()` + a re-read on the empty result is the same pattern
 * `upsertAutoContact` uses, and for the same reason: Resend retries
 * webhook deliveries, so a duplicate is an expected event, not an error. A bare
 * insert would turn the `emails_message_id_unique` violation into a 500 — which
 * Resend would then retry forever, against a row that is already stored.
 *
 * The conflict target is pinned to `message_id`: an untargeted
 * `onConflictDoNothing()` would also swallow a violation of some *other*
 * constraint, and the re-read below would then miss and report it as a generic
 * "insert failed", hiding the real cause. Only the redelivery case is meant to
 * be absorbed here; anything else should surface as the error it is.
 */
export async function insertInboundEmail(
	db: Database,
	values: NewInboundEmail
): Promise<InsertInboundEmailResult> {
	const [inserted] = await db
		.insert(emails)
		.values({ ...values, direction: 'inbound', isRead: false, isDeleted: false })
		.onConflictDoNothing({ target: emails.messageId })
		.returning();

	if (inserted) return { email: inserted, created: true };

	const existing = await getEmailByMessageId(db, values.messageId);
	if (existing) return { email: existing, created: false };

	throw new Error(`inbound email insert failed for message_id ${values.messageId}`);
}

/**
 * Inserts an email this app just sent (US-H02).
 *
 * `direction = 'outbound'` and `is_read = true` are set here, not by the caller,
 * for the same reason `insertInboundEmail` pins its own pair: those two columns
 * are what "this row is a sent message" *means*, and a caller that could pass
 * them could write a row that lies about which it is.
 *
 * A bare insert, deliberately unlike the inbound path's `onConflictDoNothing`:
 * the `message_id` here is one this app minted for this one send (see
 * `outbound/message-id.ts`), so a unique-index violation is not an expected
 * redelivery to absorb — it is a bug worth surfacing loudly.
 */
export async function insertOutboundEmail(db: Database, values: NewOutboundEmail): Promise<Email> {
	const { sentAt, ...rest } = values;
	const [inserted] = await db
		.insert(emails)
		.values({
			...rest,
			direction: 'outbound',
			bccEmails: [],
			isRead: true,
			isDeleted: false,
			receivedAt: sentAt
		})
		.returning();

	if (!inserted) throw new Error(`outbound email insert failed for message_id ${values.messageId}`);
	return inserted;
}

/**
 * Records that a *sent* message joined a thread (US-H02).
 *
 * The counterpart to `touchThreadForNewMessage`, and different in exactly one
 * way: `is_read` is **recomputed** instead of forced to false. A sent message is
 * read by definition, so it must not re-flag a thread the owner has already
 * caught up on — but neither may it silently mark one read: replying to a thread
 * whose other messages are still unread leaves it unread. The recompute answers
 * both, and it is also what makes a brand-new outbound-only thread read, since
 * `createThread` writes every thread `is_read = false`.
 *
 * `last_message_at` moves forward only, in SQL, for the reason
 * `touchThreadForNewMessage` documents.
 */
export async function touchThreadForSentMessage(
	db: Database,
	threadId: string,
	messageAt: Date
): Promise<void> {
	await db
		.update(threads)
		.set({ lastMessageAt: sql`max(${threads.lastMessageAt}, ${messageAt.getTime()})` })
		.where(eq(threads.id, threadId));

	await recomputeThreadIsRead(db, threadId);
}

/**
 * Finds the thread of the first email whose `message_id` is one of `messageIds`
 * (US-E04, FR-4's primary strategy).
 *
 * Takes a list rather than a single id so the caller can pass `In-Reply-To`
 * followed by the `References` chain in priority order: the direct parent is
 * the best answer, but a client that sent only `References`, or a parent this
 * mailbox never received, still threads off an ancestor. `inArray` returns
 * rows in no particular order, so the caller's ordering is re-applied here
 * rather than trusted from the query.
 */
export async function findThreadIdByMessageIds(
	db: Database,
	messageIds: string[]
): Promise<string | null> {
	if (messageIds.length === 0) return null;

	const rows = await db
		.select({ messageId: emails.messageId, threadId: emails.threadId })
		.from(emails)
		.where(inArray(emails.messageId, messageIds));
	if (rows.length === 0) return null;

	const byMessageId = new Map(rows.map((row) => [row.messageId, row.threadId]));
	for (const messageId of messageIds) {
		const threadId = byMessageId.get(messageId);
		if (threadId) return threadId;
	}
	return null;
}

/**
 * FR-4's secondary strategy: the most recent thread with the same *normalized*
 * subject whose last message landed within `windowMs`.
 *
 * The comparison is a plain equality against `threads.subject` because that
 * column already stores the normalized form (see `inbound/threading.ts`).
 * Deliberately no match on an empty subject — every subject-less email would
 * otherwise pile into a single thread.
 */
export async function findThreadBySubject(
	db: Database,
	normalizedSubject: string,
	since: Date
): Promise<Thread | undefined> {
	if (normalizedSubject === '') return undefined;

	const [row] = await db
		.select()
		.from(threads)
		.where(and(eq(threads.subject, normalizedSubject), gte(threads.lastMessageAt, since)))
		.orderBy(desc(threads.lastMessageAt))
		.limit(1);
	return row;
}

/**
 * Records that an unread message joined a thread.
 *
 * `is_read` is forced back to false because the Data Model PRD defines it as
 * "true only if every message in thread is read" — a newly arrived inbound
 * email is unread by definition, so a previously-read thread becomes unread
 * again. `last_message_at` only ever moves forward: a late redelivery of an
 * older message must not drag a thread down the inbox sort order.
 *
 * The forward-only comparison is done in SQL (`max()`) rather than as a JS
 * read-modify-write, for the same reason `incrementAuthCodeAttempts` does its
 * arithmetic in SQL: two messages arriving into one thread concurrently would
 * otherwise interleave select-then-update and let the older one's timestamp
 * land last, defeating the very monotonicity this function exists to enforce.
 * An update against an unknown `threadId` is a no-op, so no existence check is
 * needed.
 */
export async function touchThreadForNewMessage(
	db: Database,
	threadId: string,
	messageAt: Date
): Promise<void> {
	await db
		.update(threads)
		.set({
			isRead: false,
			lastMessageAt: sql`max(${threads.lastMessageAt}, ${messageAt.getTime()})`
		})
		.where(eq(threads.id, threadId));
}

/**
 * Marks every email in a thread read and recomputes `threads.is_read`
 * (US-F02): opening a thread is what makes it read.
 *
 * Two properties worth keeping:
 *
 * - The thread flag is **recomputed** from the emails rather than assumed to be
 *   true. `threads.is_read` means "every message in the thread is read" (Data
 *   Model PRD), and an inbound message can land between the two statements —
 *   `touchThreadForNewMessage` would set the thread unread, and a blind
 *   `set({ isRead: true })` here would then hide a message the owner never saw.
 *   The `not exists` sees that row and leaves the thread unread.
 * - Soft-deleted emails are marked read too (they are messages of the thread),
 *   but only non-deleted ones count toward the thread flag — otherwise a
 *   deleted-but-unread email would pin the thread unread forever with no
 *   visible message explaining why. That matches `listInboxThreads`, where a
 *   soft-deleted email is not a visible message either.
 *
 * Both statements run in one transaction so a failure of the recompute can't
 * leave read emails under an unread thread (or the reverse).
 */
export async function markThreadRead(db: Database, threadId: string): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.update(emails)
			.set({ isRead: true })
			.where(and(eq(emails.threadId, threadId), eq(emails.isRead, false)));

		await recomputeThreadIsRead(tx, threadId);
	});
}

/**
 * Rewrites `threads.is_read` from the thread's emails: true exactly when no
 * *visible* (non-deleted) email is unread.
 *
 * This is the single definition of that aggregate, shared by `markThreadRead`,
 * `softDeleteThreadEmail` (US-G04) and `touchThreadForSentMessage` (US-H02) —
 * each changes the set of unread visible emails, and three copies of the
 * `not exists` would be three things to keep in step. Always a recompute, never an assignment: see `markThreadRead`'s note
 * for the interleaving that a blind `set({ isRead: true })` loses.
 *
 * Takes a `Database` like every other helper here, but callers are expected to
 * pass a transaction handle — on its own this is only half of an update.
 */
async function recomputeThreadIsRead(db: Database, threadId: string): Promise<void> {
	await db
		.update(threads)
		.set({
			isRead: sql`not exists (
				select 1 from ${emails} ue
				where ue.thread_id = ${threadId} and ue.is_read = 0 and ue.is_deleted = 0
			)`
		})
		.where(eq(threads.id, threadId));
}

export type SoftDeleteEmailResult = {
	/** False when no email with that id belongs to this thread — the caller's 404. */
	found: boolean;
	/** How many non-deleted emails the thread has left; 0 means nothing left to render. */
	visibleRemaining: number;
};

/**
 * Soft-deletes one email of a thread (US-G04, FR-4): sets `is_deleted = true`,
 * never removes the row. v1 has no hard delete anywhere (Data Model PRD FR-3),
 * so the message leaves every view — `listThreadEmails`, `listInboxThreads`'
 * inner join, the attachment download lookup — while the bytes stay.
 *
 * `threadId` is part of the update's `where`, not just the lookup: the id comes
 * from a form field on a page addressed by thread, and holding an email id is
 * not permission to delete it through some other thread's URL. A mismatch is
 * the same `found: false` as an unknown id, so a probe can't tell them apart.
 *
 * Deleting is **idempotent**: an email that is already deleted still reports
 * `found: true`, because the alternative is a double-submitted form (or a
 * back-then-resubmit) answering 404 for a message the owner did successfully
 * delete.
 *
 * Everything runs in one transaction, and the two follow-ups are the reason:
 *
 * - `threads.is_read` is recomputed, because a deleted email stops counting
 *   toward it. Deleting the one unread message of a thread has to leave the
 *   thread read, or the inbox shows an unread dot with no visible message
 *   behind it — the mirror of the case `markThreadRead` guards.
 * - `visibleRemaining` is counted here rather than re-queried by the caller, so
 *   the "was that the last one?" answer comes from the same snapshot as the
 *   delete. `threads.last_message_at` is deliberately left alone: it is the
 *   inbox sort key, and a thread with no visible email is dropped by the list's
 *   inner join rather than sorted, so nothing reads a stale value.
 */
export async function softDeleteThreadEmail(
	db: Database,
	threadId: string,
	emailId: string
): Promise<SoftDeleteEmailResult> {
	return db.transaction(async (tx) => {
		const [target] = await tx
			.select({ id: emails.id })
			.from(emails)
			.where(and(eq(emails.id, emailId), eq(emails.threadId, threadId)))
			.limit(1);
		if (!target) return { found: false, visibleRemaining: 0 };

		await tx.update(emails).set({ isDeleted: true }).where(eq(emails.id, emailId));

		await recomputeThreadIsRead(tx, threadId);

		const [remaining] = await tx
			.select({ count: sql<number>`count(*)` })
			.from(emails)
			.where(and(eq(emails.threadId, threadId), eq(emails.isDeleted, false)));

		return { found: true, visibleRemaining: remaining?.count ?? 0 };
	});
}

/**
 * Creates a thread. `subject` must already be normalized
 * (`inbound/threading.ts`) — the column is the grouping key for FR-4's subject
 * fallback, and a raw `Re: …` written here would never match again.
 */
export async function createThread(
	db: Database,
	values: { subject: string; lastMessageAt: Date }
): Promise<Thread> {
	const [thread] = await db
		.insert(threads)
		.values({ subject: values.subject, lastMessageAt: values.lastMessageAt, isRead: false })
		.returning();
	return thread;
}

/** Removes a thread row. Used to clean up a thread whose email lost an insert race. */
export async function deleteThread(db: Database, threadId: string): Promise<void> {
	await db.delete(threads).where(eq(threads.id, threadId));
}
