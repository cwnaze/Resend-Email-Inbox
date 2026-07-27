// Thin Resend client wrapper (server-only).
//
// Exports what's needed today: sending the auth-code email (US-B02) and
// fetching a received email's full content (US-E02). Outbound-mail-sending
// stories (US-H02) can add a general `sendEmail` helper alongside these rather
// than duplicating the client setup.
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
