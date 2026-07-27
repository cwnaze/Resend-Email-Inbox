// Thin Resend client wrapper (server-only).
//
// Only exports what's needed today: sending the auth-code email (US-B02).
// Outbound-mail-sending stories (US-H02) can add a general `sendEmail`
// helper alongside this rather than duplicating the client setup.
//
// Both env reads are lazy (first send, not module import) on purpose:
// `npm run build` imports every `+server.ts` to detect its exported HTTP
// methods, so an import-time `requireEnv` would make the build itself — and
// therefore CI and any fresh clone — require real or placeholder secrets.
// Deferring to the first send loses nothing: an unset key still throws, at the
// only moment it actually matters.
import { Resend } from 'resend';
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
