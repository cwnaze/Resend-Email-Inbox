// Drizzle query helpers for the `emails` and `threads` tables (US-E03).
//
// Same shape as `contacts.ts` / `src/lib/server/auth/*.ts`: the db handle is the
// first argument (typed via `Database` from `./types`) rather than importing the
// `db` singleton, so this module never pulls in `$env/dynamic/private` and can
// be exercised by a standalone `tsx` verification script.
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
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

export async function getEmailByMessageId(
	db: Database,
	messageId: string
): Promise<Email | undefined> {
	const [row] = await db.select().from(emails).where(eq(emails.messageId, messageId)).limit(1);
	return row;
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
 * `upsertContactFromInbound` uses, and for the same reason: Resend retries
 * webhook deliveries, so a duplicate is an expected event, not an error. A bare
 * insert would turn the `emails_message_id_unique` violation into a 500 — which
 * Resend would then retry forever, against a row that is already stored.
 */
export async function insertInboundEmail(
	db: Database,
	values: NewInboundEmail
): Promise<InsertInboundEmailResult> {
	const [inserted] = await db
		.insert(emails)
		.values({ ...values, direction: 'inbound', isRead: false, isDeleted: false })
		.onConflictDoNothing()
		.returning();

	if (inserted) return { email: inserted, created: true };

	const existing = await getEmailByMessageId(db, values.messageId);
	if (existing) return { email: existing, created: false };

	throw new Error(`inbound email insert failed for message_id ${values.messageId}`);
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
 */
export async function touchThreadForNewMessage(
	db: Database,
	threadId: string,
	messageAt: Date
): Promise<void> {
	const [thread] = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
	if (!thread) return;

	await db
		.update(threads)
		.set({
			isRead: false,
			lastMessageAt: messageAt > thread.lastMessageAt ? messageAt : thread.lastMessageAt
		})
		.where(eq(threads.id, threadId));
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
