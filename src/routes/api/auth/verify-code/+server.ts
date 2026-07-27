// POST /api/auth/verify-code (US-B03)
//
// Accepts a 6-digit code, hashes it, and compares it against the most
// recently requested auth_codes row. See tasks/prd-auth.md (US-B03,
// FR-2, FR-4, FR-6, FR-7, FR-8, FR-9).
//
// On match: marks the code row used, creates a sessions row, and sets an
// opaque session token as an httpOnly/Secure/SameSite=Lax cookie (the raw
// token is never persisted — only its SHA-256 hash is stored in `sessions`,
// mirroring the code-hashing pattern from US-B02).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	expireAuthCode,
	getLatestAuthCode,
	hashAuthCode,
	incrementAuthCodeAttempts,
	markAuthCodeUsed
} from '$lib/server/auth/auth-codes';
import { createSession, hashSessionToken } from '$lib/server/auth/sessions-store';
import { SESSION_COOKIE_NAME } from '$lib/server/auth/session';

const MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, per FR-9

function hashesMatch(a: string, b: string): boolean {
	const bufA = Buffer.from(a, 'hex');
	const bufB = Buffer.from(b, 'hex');
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

function generateSessionToken(): string {
	// Opaque 32-byte token, per tasks/prd-auth.md's Technical Considerations.
	return randomBytes(32).toString('hex');
}

export const POST: RequestHandler = async ({ request, cookies }) => {
	let code: unknown;
	try {
		const body = await request.json();
		code = body?.code;
	} catch {
		return json({ error: 'Invalid request body.' }, { status: 400 });
	}

	if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
		return json({ error: 'Code must be 6 digits.' }, { status: 400 });
	}

	const now = new Date();
	const latest = await getLatestAuthCode(db);

	if (!latest) {
		return json(
			{ error: 'No code has been requested. Please request a new code.' },
			{ status: 400 }
		);
	}

	if (latest.usedAt !== null) {
		return json(
			{ error: 'This code has already been used. Please request a new code.' },
			{ status: 400 }
		);
	}

	if (latest.expiresAt.getTime() <= now.getTime()) {
		return json({ error: 'This code has expired. Please request a new code.' }, { status: 400 });
	}

	const submittedHash = hashAuthCode(code);
	if (!hashesMatch(submittedHash, latest.codeHash)) {
		const updated = await incrementAuthCodeAttempts(db, latest.id);
		const attemptCount = updated?.attemptCount ?? latest.attemptCount + 1;

		if (attemptCount >= MAX_ATTEMPTS) {
			// Expire the code rather than stamping `used_at`: it was burned by wrong
			// guesses, never redeemed. `used_at IS NOT NULL` has to keep meaning
			// exactly "successfully entered" (see auth-codes.ts), and the
			// already-used branch above would otherwise tell the user their code was
			// "already used" when they never got it right.
			await expireAuthCode(db, latest.id, now);
			return json(
				{ error: 'Too many incorrect attempts. Please request a new code.' },
				{ status: 400 }
			);
		}

		return json({ error: 'Incorrect code.' }, { status: 400 });
	}

	// Atomic compare-and-swap: an `undefined` return means a concurrent request
	// carrying the same correct code already consumed it, and this one must not
	// also mint a session (US-B01's helper exists precisely to make that race
	// detectable — ignoring the return value reintroduces it).
	const consumed = await markAuthCodeUsed(db, latest.id, now);
	if (!consumed) {
		return json(
			{ error: 'This code has already been used. Please request a new code.' },
			{ status: 400 }
		);
	}

	const sessionToken = generateSessionToken();
	const tokenHash = hashSessionToken(sessionToken);
	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
	await createSession(db, tokenHash, expiresAt);

	cookies.set(SESSION_COOKIE_NAME, sessionToken, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		expires: expiresAt
	});

	return json({ ok: true });
};
