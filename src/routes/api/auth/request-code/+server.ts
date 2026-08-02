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
	createAuthCodeWithinRateLimit,
	deleteAuthCode,
	getAuthCodeRequestWindow,
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

	const code = generateCode();
	const expiresAt = new Date(now.getTime() + CODE_TTL_MS);

	// The rate-limit check and the insert are one statement: the count is
	// derived from the rows this endpoint writes, so checking separately would
	// let concurrent unauthenticated POSTs all read the same pre-insert count,
	// all pass, and all send an email. A `null` here means the window was full.
	const codeId = await createAuthCodeWithinRateLimit(
		db,
		hashAuthCode(code),
		expiresAt,
		windowStart,
		RATE_LIMIT_MAX_REQUESTS
	);

	if (codeId === null) {
		// Only the throttled path pays for this read, and it's purely cosmetic:
		// the oldest request in the window is the next to age out, so it's what
		// "try again in N" is measured from.
		const { oldestCreatedAt } = await getAuthCodeRequestWindow(db, windowStart);
		const retryAtMs = (oldestCreatedAt?.getTime() ?? now.getTime()) + RATE_LIMIT_WINDOW_MS;
		const retryAfterSeconds = Math.max(1, Math.ceil((retryAtMs - now.getTime()) / 1000));
		return json(
			{
				error: 'Too many code requests. Please try again later.',
				retryAfterMinutes: Math.max(1, Math.ceil(retryAfterSeconds / 60))
			},
			{
				status: 429,
				// Standard signal for any client that isn't our own UI. Derived from the
				// same oldest-request timestamp as retryAfterMinutes, so the header and
				// the body can't disagree.
				headers: { 'Retry-After': String(retryAfterSeconds) }
			}
		);
	}

	// Supersede the previous code only now that its replacement actually exists,
	// exempting the row we just wrote — it is unused and unexpired, so it would
	// otherwise match and expire itself.
	await invalidateActiveAuthCodes(db, now, codeId);

	try {
		await sendAuthCodeEmail(code);
	} catch (err) {
		// The plaintext code only ever existed in this request, so a row whose
		// email never went out is unusable: keeping it would leave the user with
		// no valid code (the previous one was just superseded) *and* burn one of
		// their three requests per window. Roll it back and let them retry.
		await deleteAuthCode(db, codeId);
		console.error('auth code email failed, rolled back code row:', err);
		return json({ error: 'Could not send the code. Please try again.' }, { status: 502 });
	}

	return json({ ok: true });
};
