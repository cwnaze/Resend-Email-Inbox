// Thin Resend client wrapper (server-only).
//
// Only exports what's needed today: sending the auth-code email (US-B02).
// Outbound-mail-sending stories (US-H02) can add a general `sendEmail`
// helper alongside this rather than duplicating the client setup.
import { Resend } from 'resend';
import { env } from '$env/dynamic/private';

function requireEnv(name: 'RESEND_API_KEY' | 'AUTH_RECIPIENT_EMAIL'): string {
	const value = env[name];
	if (!value) {
		throw new Error(`${name} is not set`);
	}
	return value;
}

const apiKey = requireEnv('RESEND_API_KEY');

/**
 * The sole recipient of auth-code emails. This is a server-side constant —
 * never read from request input — so there is no way for a request to
 * redirect the code to an attacker-controlled address (FR-1, tasks/prd-auth.md).
 */
export const AUTH_RECIPIENT_EMAIL = requireEnv('AUTH_RECIPIENT_EMAIL');

const AUTH_SENDER_EMAIL = 'auth@caseynazelrod.com';

const resend = new Resend(apiKey);

/** Sends the 6-digit login code to the constant AUTH_RECIPIENT_EMAIL via Resend. */
export async function sendAuthCodeEmail(code: string) {
	const { error } = await resend.emails.send({
		from: AUTH_SENDER_EMAIL,
		to: AUTH_RECIPIENT_EMAIL,
		subject: 'Your login code',
		text: `Your login code is ${code}. It expires in 10 minutes.`,
		html: `<p>Your login code is <strong style="font-family: monospace; font-size: 1.25em;">${code}</strong>.</p><p>It expires in 10 minutes.</p>`
	});
	if (error) {
		throw new Error(`Failed to send auth code email: ${error.message}`);
	}
}
