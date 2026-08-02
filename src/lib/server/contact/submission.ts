// Contact-form submissions → inbox emails.
//
// caseynazelrod.com is a static site with no backend of its own, so its contact
// form POSTs here. A submission is *not* routed through Resend: nothing needs to
// leave this system for the message to end up in the inbox, and a round trip
// through an outbound send + inbound webhook would only add a delivery that can
// fail. The submission is written straight to `emails` via the same
// `storeInboundEmail` path a real inbound delivery uses, so it threads, upserts
// a contact, and renders exactly like any other message.
//
// Pure except for the db handle it is given — no env, no `fetch` — so it can be
// driven from a script the way the other `src/lib/server/**` modules are.
import { upsertAutoContact } from '../db/contacts';
import type { Database } from '../db/types';
import { storeInboundEmail, type StoreInboundEmailResult } from '../inbound/store';
import type { ParsedInboundEmail } from '../inbound/parse';

export type ContactSubmission = {
	name: string;
	email: string;
	message: string;
};

export type ValidationResult =
	{ ok: true; value: ContactSubmission } | { ok: false; reason: string };

/** Caps borrowed from what a form field can sanely hold — anything past this is abuse, not a message. */
const MAX_NAME = 200;
const MAX_EMAIL = 320;
const MAX_MESSAGE = 10_000;

// Deliberately loose: this is a shape check to reject obvious junk, not an
// attempt to decide RFC 5322 validity. The address is stored, never trusted.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Address a stored submission is filed under.
 *
 * A server-side constant, for the same reason `getOutboundSender()` is one: the
 * recipient of a stored message must never be influenced by request input.
 *
 * On the **apex**, not `mail.` — Resend holds the apex MX, so this is a real
 * deliverable address, while `mail.` is the app's own hostname and receives no
 * mail (docs/notes/inbound.md). Not `AUTH_RECIPIENT_EMAIL` either: that is the
 * owner's personal Gmail for login codes, and filing contact-form messages under
 * it would show every one of them as addressed outside this mailbox.
 *
 * The same address `getOutboundSender()` sends as, so replying to a submission
 * from the inbox goes out from the address it was addressed to.
 */
export const CONTACT_MAILBOX = 'casey@caseynazelrod.com';

/**
 * Validates and normalizes an untrusted JSON body from the public form.
 *
 * Every field is required and trimmed. Control characters are stripped from the
 * single-line fields (name, email) so a submitted `\r\n` can never end up
 * looking like a header boundary anywhere downstream; the message body keeps its
 * newlines, since it is stored as plain text and rendered as such.
 */
export function validateSubmission(body: unknown): ValidationResult {
	if (typeof body !== 'object' || body === null)
		return { ok: false, reason: 'body is not an object' };

	const raw = body as Record<string, unknown>;
	const single = (value: unknown) =>
		typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';

	const name = single(raw.name);
	const email = single(raw.email).toLowerCase();
	const message = typeof raw.message === 'string' ? raw.message.trim() : '';

	if (!name) return { ok: false, reason: 'name is required' };
	if (name.length > MAX_NAME) return { ok: false, reason: 'name is too long' };
	if (!email) return { ok: false, reason: 'email is required' };
	if (email.length > MAX_EMAIL || !EMAIL_SHAPE.test(email)) {
		return { ok: false, reason: 'email is not a valid address' };
	}
	if (!message) return { ok: false, reason: 'message is required' };
	if (message.length > MAX_MESSAGE) return { ok: false, reason: 'message is too long' };

	return { ok: true, value: { name, email, message } };
}

/**
 * Builds the `ParsedInboundEmail` a submission stands in for.
 *
 * `messageId` is synthesized and unique per submission — there is no RFC message
 * to be idempotent against, and two identical submissions are two messages, not
 * a redelivery. Threading therefore falls to the subject heuristic, and the
 * subject carries the sender's name so one person writing twice in a month lands
 * in one thread instead of collapsing every visitor into a single "Contact form"
 * conversation.
 *
 * `bodyHtml` is left null on purpose: the message is plain text the sender typed,
 * and storing it as text means there is no markup to sanitize and no way for a
 * submitted `<script>` to become one.
 */
export function buildSubmissionEmail(
	submission: ContactSubmission,
	now: Date = new Date()
): ParsedInboundEmail {
	const domain = CONTACT_MAILBOX.split('@')[1];

	return {
		resendEmailId: `contact-form-${crypto.randomUUID()}`,
		messageId: `<contact-${crypto.randomUUID()}@${domain}>`,
		inReplyTo: null,
		references: [],
		fromEmail: submission.email,
		fromName: submission.name,
		toEmails: [CONTACT_MAILBOX],
		ccEmails: [],
		bccEmails: [],
		replyToEmails: [submission.email],
		subject: `Contact form: ${submission.name}`,
		bodyHtml: null,
		bodyText: submission.message,
		receivedAt: now,
		attachments: []
	};
}

/** Upserts the sender as a contact and stores the submission as an inbound email. */
export async function storeContactSubmission(
	db: Database,
	submission: ContactSubmission,
	now: Date = new Date()
): Promise<StoreInboundEmailResult> {
	await upsertAutoContact(db, { email: submission.email, name: submission.name }, now);
	return storeInboundEmail(db, buildSubmissionEmail(submission, now), now);
}
