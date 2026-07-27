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
	getEmailByMessageId,
	insertInboundEmail,
	type Email
} from '../db/emails';
import type { Database } from '../db/types';
import type { ParsedInboundEmail } from './parse';
import { sanitizeEmailHtml } from './sanitize';

export type StoreInboundEmailResult = {
	email: Email;
	/** False when this `message_id` was already stored — a duplicate delivery. */
	created: boolean;
};

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
 */
export async function storeInboundEmail(
	db: Database,
	parsed: ParsedInboundEmail
): Promise<StoreInboundEmailResult> {
	const duplicate = await getEmailByMessageId(db, parsed.messageId);
	if (duplicate) return { email: duplicate, created: false };

	// US-E04 replaces this with In-Reply-To / subject matching; today every new
	// email starts its own thread.
	const thread = await createThread(db, {
		subject: parsed.subject,
		lastMessageAt: parsed.receivedAt
	});

	const result = await insertInboundEmail(db, {
		threadId: thread.id,
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
		await deleteThread(db, thread.id);
	}

	return result;
}
