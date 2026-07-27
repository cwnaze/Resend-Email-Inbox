// POST /api/auth/request-code (US-B02)
//
// Generates a 6-digit login code, stores only its SHA-256 hash, emails it to
// the constant AUTH_RECIPIENT_EMAIL via Resend, and rate-limits requests to
// 3 per rolling 10-minute window. See tasks/prd-auth.md (US-B02, FR-1..FR-5).
import { randomInt } from 'node:crypto';
import { createHash } from 'node:crypto';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	countAuthCodeRequestsSince,
	createAuthCode,
	getOldestAuthCodeRequestSince,
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

function hashCode(code: string): string {
	return createHash('sha256').update(code).digest('hex');
}

export const POST: RequestHandler = async () => {
	const now = new Date();
	const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);

	const recentRequestCount = await countAuthCodeRequestsSince(db, windowStart);
	if (recentRequestCount >= RATE_LIMIT_MAX_REQUESTS) {
		const oldestRequestAt = await getOldestAuthCodeRequestSince(db, windowStart);
		const retryAtMs = (oldestRequestAt?.getTime() ?? now.getTime()) + RATE_LIMIT_WINDOW_MS;
		const retryAfterMinutes = Math.max(1, Math.ceil((retryAtMs - now.getTime()) / 60_000));
		return json(
			{
				error: 'Too many code requests. Please try again later.',
				retryAfterMinutes
			},
			{ status: 429 }
		);
	}

	await invalidateActiveAuthCodes(db, now);

	const code = generateCode();
	const codeHash = hashCode(code);
	const expiresAt = new Date(now.getTime() + CODE_TTL_MS);

	await createAuthCode(db, codeHash, expiresAt);
	await sendAuthCodeEmail(code);

	return json({ ok: true });
};
