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
 * Returns the created thread's id plus `createdThreadId` so the caller can undo
 * it if the email insert turns out to be a duplicate — a thread with nothing
 * pointing at it is litter in the inbox list.
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
	const { threadId, match, createdThreadId } = await assignThread(
		db,
		parsed,
		normalizedSubject,
		now
	);

	const result = await insertInboundEmail(db, {
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
		// Lost the race on the unique index: undo the thread this call created (if
		// it created one) rather than leaving an empty conversation behind. A
		// thread we merely *joined* is left alone — it has other emails in it.
		if (createdThreadId) await deleteThread(db, createdThreadId);
		return { ...result, threadMatch: 'duplicate' };
	}

	// Only after the email is actually stored: a new unread message makes its
	// thread unread and (unless it is older) bumps its sort timestamp.
	await touchThreadForNewMessage(db, threadId, parsed.receivedAt);

	return { ...result, threadMatch: match };
}
