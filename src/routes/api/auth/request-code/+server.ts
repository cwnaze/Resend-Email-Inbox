// POST /api/auth/request-code (US-B02)
//
// Generates a 6-digit login code, stores only its SHA-256 hash, emails it to
// the constant AUTH_RECIPIENT_EMAIL via Resend, and rate-limits requests to
// 3 per rolling 10-minute window. See tasks/prd-auth.md (US-B02, FR-1..FR-5).
import { randomInt } from 'node:crypto';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	countAuthCodeRequestsSince,
	createAuthCode,
	deleteAuthCode,
	hashAuthCode,
	invalidateActiveAuthCodes
} from '$lib/server/auth/auth-codes';
import { sendAuthCodeEmail } from '$lib/server/email/resend';

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_REQUESTS = 3;

function generateCode(): string {
	// Cryptographically random 6-digit code, zero-padded (e.g. "004821").
	return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export const POST: RequestHandler = async () => {
	const now = new Date();
	const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);

	const recentRequestCount = await countAuthCodeRequestsSince(db, windowStart);
	if (recentRequestCount >= RATE_LIMIT_MAX_REQUESTS) {
		return json(
			{ error: 'Too many code requests. Please try again later.' },
			{
				status: 429,
				// Standard signal for any client that isn't our own UI. The window is
				// rolling, so this is the worst case (a slot frees up sooner if the
				// earliest request in the window is older than "just now").
				headers: { 'Retry-After': String(RATE_LIMIT_WINDOW_MS / 1000) }
			}
		);
	}

	await invalidateActiveAuthCodes(db, now);

	const code = generateCode();
	const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
	const row = await createAuthCode(db, hashAuthCode(code), expiresAt);

	try {
		await sendAuthCodeEmail(code);
	} catch (err) {
		// The plaintext code only ever existed in this request, so a row whose
		// email never went out is unusable: keeping it would leave the user with
		// no valid code (the previous one was just superseded) *and* burn one of
		// their three requests per window. Roll it back and let them retry.
		await deleteAuthCode(db, row.id);
		console.error('auth code email failed, rolled back code row:', err);
		return json({ error: 'Could not send the code. Please try again.' }, { status: 502 });
	}

	return json({ ok: true });
};
