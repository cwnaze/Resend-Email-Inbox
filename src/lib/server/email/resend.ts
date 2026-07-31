// Thin Resend client wrapper (server-only).
//
// Exports what's needed today: sending the auth-code email (US-B02), fetching a
// received email's full content and attachments (US-E02/US-E05), and sending a
// composed outbound email (US-H02). Every one of them goes through the single
// lazily-built `getClient()` rather than constructing its own.
//
// Both env reads are lazy (first send, not module import) on purpose:
// `npm run build` imports every `+server.ts` to detect its exported HTTP
// methods, so an import-time `requireEnv` would make the build itself — and
// therefore CI and any fresh clone — require real or placeholder secrets.
// Deferring to the first send loses nothing: an unset key still throws, at the
// only moment it actually matters.
import { Resend } from 'resend';
import type { GetReceivingEmailResponseSuccess } from 'resend';
import { env } from '$env/dynamic/private';

function requireEnv(name: 'RESEND_API_KEY' | 'AUTH_RECIPIENT_EMAIL'): string {
	const value = env[name];
	if (!value) {
		throw new Error(`${name} is not set`);
	}
	return value;
}

let client: Resend | undefined;

function getClient(): Resend {
	return (client ??= new Resend(requireEnv('RESEND_API_KEY')));
}

/**
 * The sole recipient of auth-code emails. This is a server-side constant —
 * never read from request input — so there is no way for a request to
 * redirect the code to an attacker-controlled address (FR-1, tasks/prd-auth.md).
 */
export function getAuthRecipient(): string {
	return requireEnv('AUTH_RECIPIENT_EMAIL');
}

const AUTH_SENDER_EMAIL = 'auth@caseynazelrod.com';

/**
 * Sends the 6-digit login code to the constant AUTH_RECIPIENT_EMAIL via Resend.
 *
 * On failure the provider's message is logged server-side and a generic `Error`
 * is thrown, so nothing Resend says can be echoed back to the client by an
 * unhandled-error page.
 */
export async function sendAuthCodeEmail(code: string) {
	const { error } = await getClient().emails.send({
		from: AUTH_SENDER_EMAIL,
		to: getAuthRecipient(),
		subject: 'Your login code',
		text: `Your login code is ${code}. It expires in 10 minutes.`,
		html: `<p>Your login code is <strong style="font-family: monospace; font-size: 1.25em;">${code}</strong>.</p><p>It expires in 10 minutes.</p>`
	});
	if (error) {
		console.error('Resend auth-code send failed:', error);
		throw new Error('Failed to send auth code email');
	}
}

/**
 * The address outbound mail is sent as (US-H02, FR-1).
 *
 * A server-side constant like `AUTH_SENDER_EMAIL`, not a request input and not
 * an env var: the sending domain is fixed by the Resend account, and `from` is
 * the one field of an outbound send that must never be influenced by what the
 * form submitted.
 *
 * On the apex, which is where Resend holds the MX (see CLAUDE.md) — so a reply
 * to something this app sent comes back through the inbound webhook and lands in
 * this inbox, rather than bouncing off a subdomain nothing receives.
 */
const OUTBOUND_SENDER_EMAIL = 'casey@caseynazelrod.com';

export function getOutboundSender(): string {
	return OUTBOUND_SENDER_EMAIL;
}

export type OutboundEmail = {
	to: string[];
	cc: string[];
	subject: string;
	/** The composed message, as typed. Plain text is the only body v1 sends. */
	text: string;
	/**
	 * The `Message-ID` to put on the wire, angle brackets included, minted by
	 * `outbound/message-id.ts`. Passed in rather than generated here because the
	 * *same* string is written to `emails.message_id` — that pairing is what makes
	 * a reply thread back onto this message.
	 */
	messageId: string;
	/** The parent's `Message-ID`, for a reply (US-H03). Null for a new message. */
	inReplyTo?: string | null;
};

/**
 * A send that did not happen. Carries a message safe to show the owner: the
 * provider's own wording is logged server-side only, matching every other error
 * in this module.
 */
export class OutboundSendError extends Error {
	constructor() {
		super('Failed to send email');
		this.name = 'OutboundSendError';
	}
}

/**
 * Sends one composed email (US-H02, FR-1) and returns Resend's email id.
 *
 * **Text only, no HTML part.** The compose screen is a `<textarea>`, so the
 * message *is* plain text; generating an HTML twin of it would add an escaping
 * step and a second body that can disagree with the first, in exchange for
 * nothing a recipient can see. The PRD's open question (always generate a text
 * fallback alongside HTML) is satisfied trivially in this direction — if rich
 * composition is ever added, the text part is what has to keep being generated.
 *
 * The threading headers go through `headers` because the SDK has no typed field
 * for any of them, and **which ones survive was measured, not assumed** (US-H02;
 * both probes are written up in `docs/notes/compose.md`):
 *
 * - `Message-ID` is **discarded**. Resend sends through Amazon SES, which stamps
 *   its own `<…@email.amazonses.com>` id — a send with a custom `Message-ID`
 *   arrived carrying SES's. It is still set here (it costs nothing and would
 *   start working if that ever changed) but nothing may *depend* on it: a
 *   recipient's reply will cite SES's id, which this app never learns, because
 *   `emails.get()` 404s for seconds after a send and an action cannot wait.
 * - `In-Reply-To` and `References` **are** preserved verbatim.
 *
 * That asymmetry is why `References` carries this app's own minted id even on a
 * brand-new message with no parent: a replying client copies the parent's
 * `References` into its reply, so the minted id comes back in the reply's
 * `References` chain — which `inbound/store.ts` matches against
 * `emails.message_id` (`findThreadIdByMessageIds` reads both headers). It is the
 * one header-level hook back to a message this app sent. The 30-day same-subject
 * fallback catches the rest.
 *
 * The returned id is Resend's own handle for the send — deliberately *not* what
 * `emails.message_id` stores (see `outbound/message-id.ts`); it is returned for
 * logging, where knowing which delivery a row corresponds to is worth having.
 */
export async function sendOutboundEmail(email: OutboundEmail): Promise<string> {
	// Oldest ancestor first, this message's own id last — the order `References`
	// is defined to be in, and the order `inbound/parse.ts` reverses to walk the
	// nearest ancestor first.
	const references = [email.inReplyTo, email.messageId].filter(
		(id): id is string => typeof id === 'string' && id !== ''
	);
	const headers: Record<string, string> = {
		'Message-ID': email.messageId,
		References: references.join(' ')
	};
	if (email.inReplyTo) headers['In-Reply-To'] = email.inReplyTo;

	const { data, error } = await getClient().emails.send({
		from: OUTBOUND_SENDER_EMAIL,
		to: email.to,
		// An empty array is omitted rather than sent: Resend rejects `cc: []` on
		// some paths, and "no Cc" is the absence of the field.
		...(email.cc.length > 0 ? { cc: email.cc } : {}),
		subject: email.subject,
		text: email.text,
		headers
	});

	if (error || !data) {
		console.error('Resend outbound send failed:', error);
		throw new OutboundSendError();
	}
	return data.id;
}

/**
 * Fetches a received (inbound) email's full content from Resend by its
 * `email_id`.
 *
 * This call is **not optional** for ingestion: the `email.received` webhook
 * payload carries metadata only — no body, no headers, no attachment content —
 * so `html`/`text`, the `From:` display name, `In-Reply-To` and the `Date:`
 * header are only available here. See `src/lib/server/inbound/parse.ts`.
 *
 * On failure the provider's message is logged server-side and a generic
 * `ReceivedEmailFetchError` is thrown, matching `sendAuthCodeEmail` — nothing
 * Resend says reaches a client through an unhandled-error page. The error
 * carries a `retryable` flag so the webhook endpoint can tell "try again later"
 * (5xx / rate limit / unknown) apart from "this will never work" (a 4xx such as
 * an `email_id` that no longer exists), which is the difference between a
 * useful Resend redelivery and an infinite retry loop.
 */
export class ReceivedEmailFetchError extends Error {
	readonly retryable: boolean;
	readonly statusCode: number | null;

	constructor(retryable: boolean, statusCode: number | null) {
		super('Failed to fetch received email');
		this.name = 'ReceivedEmailFetchError';
		this.retryable = retryable;
		this.statusCode = statusCode;
	}
}

/**
 * A 4xx other than 429 means the request itself is wrong — a missing or
 * inaccessible `email_id`, a revoked key — and repeating it verbatim cannot
 * start working. Everything else (5xx, 429, and a null status, which is what a
 * transport-level failure looks like) is worth another attempt.
 */
function isRetryableStatus(statusCode: number | null): boolean {
	if (statusCode === null) return true;
	if (statusCode === 429) return true;
	return statusCode < 400 || statusCode >= 500;
}

/**
 * Downloads one inbound attachment's bytes (US-E05).
 *
 * Two hops, both required: the Attachments API returns a short-lived signed
 * `download_url` (the content is never inlined — the same reason the webhook
 * itself is metadata-only), and the bytes are then fetched from it. The URL is
 * deliberately not returned to callers or persisted: it expires, and the app's
 * own download links are presigned from R2 on demand (see `server/r2`).
 *
 * Throws a plain `Error` rather than a retryable-flagged one: the caller
 * (`inbound/attachments.ts`) logs and omits a failed attachment instead of
 * failing the ingestion, so there is no retry decision to inform.
 */
export async function fetchReceivedAttachmentBytes(
	emailId: string,
	attachmentId: string
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
	const { data, error } = await getClient().emails.receiving.attachments.get({
		emailId,
		id: attachmentId
	});
	if (error || !data) {
		console.error('Resend attachment fetch failed:', emailId, attachmentId, error);
		throw new Error('Failed to fetch inbound attachment metadata');
	}

	const response = await fetch(data.download_url);
	if (!response.ok) {
		console.error(
			'Resend attachment download failed:',
			emailId,
			attachmentId,
			`status ${response.status}`
		);
		throw new Error('Failed to download inbound attachment');
	}

	return {
		bytes: new Uint8Array(await response.arrayBuffer()),
		contentType: data.content_type ?? null
	};
}

export async function fetchReceivedEmail(
	emailId: string
): Promise<GetReceivingEmailResponseSuccess> {
	const { data, error } = await getClient().emails.receiving.get(emailId);
	if (error || !data) {
		console.error('Resend received-email fetch failed:', emailId, error);
		const statusCode = error?.statusCode ?? null;
		// A success response with no payload is a contract violation, not a
		// client error — treat it as retryable.
		throw new ReceivedEmailFetchError(error ? isRetryableStatus(statusCode) : true, statusCode);
	}
	return data;
}
