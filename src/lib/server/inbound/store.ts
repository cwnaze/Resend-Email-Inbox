// Persistence step of inbound ingestion (US-E03).
//
// Sits between the pure parser (`parse.ts`) and the endpoint: takes a
// `ParsedInboundEmail`, sanitizes its HTML, and writes one `emails` row —
// idempotently on `message_id`, so a Resend redelivery is a no-op instead of a
// unique-constraint 500 (FR-2, tasks/prd-feature-inbound-processing.md).
//
// Db-handle-first like every other module under `src/lib/server/db/**`, so a
// standalone `tsx` script can drive it without `$env/dynamic/private`.
import {
	createThread,
	deleteThread,
	findThreadBySubject,
	findThreadIdByMessageIds,
	getEmailByMessageId,
	insertInboundEmail,
	touchThreadForNewMessage,
	type Email
} from '../db/emails';
import type { Database } from '../db/types';
import type { ParsedInboundEmail } from './parse';
import { sanitizeEmailHtml } from './sanitize';
import { normalizeSubject, SUBJECT_THREAD_WINDOW_MS } from './threading';

export type StoreInboundEmailResult = {
	email: Email;
	/** False when this `message_id` was already stored — a duplicate delivery. */
	created: boolean;
	/** How the email's thread was chosen — for the endpoint's log line. */
	threadMatch: 'reply' | 'subject' | 'new' | 'duplicate';
};

/**
 * Picks the thread a parsed email belongs to (US-E04, FR-4).
 *
 * Order is header matching first, subject fallback second, new thread last.
 * `In-Reply-To` and `References` are checked against `emails.message_id`;
 * headers are authoritative when present, and only their absence (or an
 * unknown parent) falls back to the fuzzy 30-day same-subject heuristic.
 *
 * Runs inside `storeInboundEmail`'s transaction, so a thread created here is
 * rolled back with everything else if the insert fails; `createdThreadId` is
 * still reported because the *duplicate* case is not a failure and has to undo
 * the thread explicitly — a thread with nothing pointing at it is litter in the
 * inbox list.
 */
async function assignThread(
	db: Database,
	parsed: ParsedInboundEmail,
	normalizedSubject: string,
	now: Date
): Promise<{
	threadId: string;
	match: 'reply' | 'subject' | 'new';
	createdThreadId: string | null;
}> {
	// `References` is oldest-first; reverse it so the nearest ancestor wins after
	// the direct parent.
	const ancestors = [parsed.inReplyTo, ...[...parsed.references].reverse()].filter(
		(id): id is string => typeof id === 'string' && id !== ''
	);

	const replyThreadId = await findThreadIdByMessageIds(db, ancestors);
	if (replyThreadId) return { threadId: replyThreadId, match: 'reply', createdThreadId: null };

	const since = new Date(now.getTime() - SUBJECT_THREAD_WINDOW_MS);
	const subjectThread = await findThreadBySubject(db, normalizedSubject, since);
	if (subjectThread) {
		return { threadId: subjectThread.id, match: 'subject', createdThreadId: null };
	}

	const thread = await createThread(db, {
		subject: normalizedSubject,
		lastMessageAt: parsed.receivedAt
	});
	return { threadId: thread.id, match: 'new', createdThreadId: thread.id };
}

/**
 * Persists a parsed inbound email.
 *
 * The duplicate check is done **twice** on purpose: a cheap read up front so a
 * redelivery never creates an orphan `threads` row, and the unique index on
 * `emails.message_id` as the authority underneath (`insertInboundEmail`) for
 * the case where two deliveries of the same message are genuinely in flight at
 * once. Only the index can win that race; only the read can avoid the litter.
 * When the read misses but the index catches it, the thread this call created
 * has nothing pointing at it and is deleted again.
 *
 * `bodyHtml` is sanitized here rather than at render time so nothing unsafe is
 * ever written to the column; `bodyText` is stored as-is (it is never rendered
 * as markup).
 *
 * Thread assignment, the insert and the thread touch all run in **one
 * transaction**. They have to be atomic in both directions: a failure after the
 * insert (a transient error on the touch) would otherwise leave a stored email
 * whose thread still reads as read with a stale `last_message_at` — and because
 * the duplicate check above short-circuits, Resend's redelivery would return
 * early and never repair it, stranding a real message out of the inbox sort
 * order permanently. Rolling back also means a failed insert takes its
 * just-created thread with it, with no best-effort cleanup to get wrong.
 *
 * `now` is injectable so the 30-day subject-fallback window can be exercised
 * deterministically from a verification script.
 */
export async function storeInboundEmail(
	db: Database,
	parsed: ParsedInboundEmail,
	now: Date = new Date()
): Promise<StoreInboundEmailResult> {
	const duplicate = await getEmailByMessageId(db, parsed.messageId);
	if (duplicate) return { email: duplicate, created: false, threadMatch: 'duplicate' };

	const normalizedSubject = normalizeSubject(parsed.subject);

	return db.transaction(async (tx) => {
		const { threadId, match, createdThreadId } = await assignThread(
			tx,
			parsed,
			normalizedSubject,
			now
		);

		const result = await insertInboundEmail(tx, {
			threadId,
			messageId: parsed.messageId,
			inReplyTo: parsed.inReplyTo,
			fromEmail: parsed.fromEmail,
			fromName: parsed.fromName,
			toEmails: parsed.toEmails,
			ccEmails: parsed.ccEmails,
			bccEmails: parsed.bccEmails,
			subject: parsed.subject,
			bodyText: parsed.bodyText,
			bodyHtml: sanitizeEmailHtml(parsed.bodyHtml),
			receivedAt: parsed.receivedAt
		});

		if (!result.created) {
			// Lost the race on the unique index. `onConflictDoNothing` is not an
			// error, so nothing rolls back on its own: undo the thread this call
			// created (if it created one) rather than leaving an empty conversation
			// behind. Safe to delete unconditionally here — the row is still
			// uncommitted, so no concurrent delivery can have attached an email to
			// it and turned this into an FK violation. A thread we merely *joined*
			// is left alone: it has other emails in it.
			if (createdThreadId) await deleteThread(tx, createdThreadId);
			return { ...result, threadMatch: 'duplicate' as const };
		}

		// Only once the email is actually stored: a new unread message makes its
		// thread unread and (unless it is older) bumps its sort timestamp.
		await touchThreadForNewMessage(tx, threadId, parsed.receivedAt);

		return { ...result, threadMatch: match };
	});
}
