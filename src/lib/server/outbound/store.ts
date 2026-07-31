// Persistence step for a sent email (US-H02).
//
// The outbound mirror of `inbound/store.ts`, and the same division of labour:
// the Resend call happens in the action, this module only writes what was sent.
// Db-handle-first like everything under `src/lib/server/db/**`, so a standalone
// `tsx` script can drive it without `$env/dynamic/private`.
import {
	createThread,
	insertOutboundEmail,
	touchThreadForSentMessage,
	type Email
} from '../db/emails';
import { upsertAutoContact } from '../db/contacts';
import type { Database } from '../db/types';
import { normalizeSubject } from '../inbound/threading';

export type SentEmail = {
	messageId: string;
	inReplyTo: string | null;
	fromEmail: string;
	toEmails: string[];
	ccEmails: string[];
	subject: string;
	bodyText: string;
	/**
	 * The thread this message joins — a reply or forward target (US-H03/H04).
	 * Null starts a new thread, which is what composing from scratch does.
	 */
	threadId: string | null;
};

export type StoreSentEmailResult = {
	email: Email;
	/** True when this call created the thread rather than joining one. */
	threadCreated: boolean;
};

/**
 * Writes a sent email: its `emails` row, its thread, and a contact per recipient.
 *
 * **A new message always starts a new thread.** Unlike inbound ingestion, there
 * is no same-subject fallback here: an arriving email's thread has to be guessed
 * because the sender's client chose the headers, whereas the owner's own intent
 * is known exactly — replying passes the parent's `threadId` (US-H03), composing
 * from scratch passes null and means a new conversation. Guessing "this looks
 * like that other thread" would silently bury a fresh message inside an old one.
 *
 * Everything runs in **one transaction**, for the reason `storeInboundEmail`
 * documents: a failure between the insert and the thread touch would otherwise
 * leave a stored message under a thread with a stale `last_message_at` (i.e. out
 * of inbox order), and unlike the inbound path there is no provider redelivery
 * that would ever come back and repair it.
 *
 * Contacts are upserted for every To and Cc address (FR-5) — `auto_created`,
 * with no display name, since compose drops display names on purpose
 * (`lib/compose/addresses.ts`). It is inside the transaction because a recipient
 * the owner has now written to should not appear in the autocomplete unless the
 * message it came from was actually recorded.
 */
export async function storeSentEmail(
	db: Database,
	sent: SentEmail,
	now: Date = new Date()
): Promise<StoreSentEmailResult> {
	return db.transaction(async (tx) => {
		let threadId = sent.threadId;
		let threadCreated = false;

		if (!threadId) {
			// The *normalized* subject, like every other `threads.subject` write: the
			// column is the grouping key inbound threading compares against, so a raw
			// `Re: …` written here would make a reply to this message fork.
			const thread = await createThread(tx, {
				subject: normalizeSubject(sent.subject),
				lastMessageAt: now
			});
			threadId = thread.id;
			threadCreated = true;
		}

		const email = await insertOutboundEmail(tx, {
			threadId,
			messageId: sent.messageId,
			inReplyTo: sent.inReplyTo,
			fromEmail: sent.fromEmail,
			toEmails: sent.toEmails,
			ccEmails: sent.ccEmails,
			subject: sent.subject,
			bodyText: sent.bodyText,
			// No HTML part is sent (see `email/resend.ts`), so there is none to store.
			// The thread view falls back to `body_text` — `bodyPlainText` in
			// `lib/inbox/format.ts` — which is the whole message here.
			bodyHtml: null,
			sentAt: now
		});

		await touchThreadForSentMessage(tx, threadId, now);

		for (const address of [...sent.toEmails, ...sent.ccEmails]) {
			await upsertAutoContact(tx, { email: address }, now);
		}

		return { email, threadCreated };
	});
}
