// Session cookie handling + real server-side session validation (US-B05).
//
// `SESSION_COOKIE_NAME` and the cookie options here are the single source of
// truth for both ends of the session lifecycle: `POST /api/auth/verify-code`
// sets the cookie, `(app)/+layout.server.ts` validates it, and
// `POST /api/auth/logout` clears it. Keep those call sites reading these
// helpers rather than re-specifying `path`/`httpOnly`/`secure`/`sameSite`
// themselves — a cookie deleted with a different `path` than it was set with
// is not actually deleted.
//
// This module deliberately does not import the `db` singleton: like
// `auth-codes.ts`/`sessions-store.ts`, every function that needs the database
// takes the handle as its first argument, so nothing here pulls in
// `$env/dynamic/private` and a standalone `tsx` script can exercise it.
import type { Cookies } from '@sveltejs/kit';
import {
	deleteSessionByTokenHash,
	extendSessionExpiry,
	getValidSessionByTokenHash,
	hashSessionToken
} from './sessions-store';
import type { Database } from '../db/types';

export const SESSION_COOKIE_NAME = 'session';

/** Session lifetime, per tasks/prd-auth.md FR-9: 30 days, sliding. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How much of the TTL must have elapsed before an active request refreshes the
 * expiry. FR-9 asks for sliding expiration, but writing on *every* request
 * would mean a DB write per page view for no user-visible benefit — refreshing
 * once the session is past its halfway point keeps the slide effectively
 * continuous (anyone active within any 15-day span never expires) at roughly
 * one write per 15 days.
 */
const SESSION_REFRESH_THRESHOLD_MS = SESSION_TTL_MS / 2;

const COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	secure: true,
	sameSite: 'lax'
} as const;

/** Sets the raw session token as the session cookie. The raw token is never persisted. */
export function setSessionCookie(cookies: Cookies, token: string, expiresAt: Date): void {
	cookies.set(SESSION_COOKIE_NAME, token, { ...COOKIE_OPTIONS, expires: expiresAt });
}

/** Clears the session cookie. Must use the same `path` the cookie was set with. */
export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE_NAME, COOKIE_OPTIONS);
}

/**
 * Validates the request's session cookie against the `sessions` table and
 * returns the row, or `null` if there is no cookie, no matching row, or the row
 * has expired. On success, applies the sliding refresh described above.
 *
 * Returning `null` for all three failure modes is intentional: the caller
 * (route protection) treats missing, unknown, and expired identically, and
 * distinguishing them would leak whether a given token ever existed.
 */
export async function validateSession(
	database: Database,
	cookies: Cookies,
	now: Date = new Date()
) {
	const token = cookies.get(SESSION_COOKIE_NAME);
	if (!token) return null;

	const tokenHash = hashSessionToken(token);
	const session = await getValidSessionByTokenHash(database, tokenHash, now);
	if (!session) return null;

	const elapsed = SESSION_TTL_MS - (session.expiresAt.getTime() - now.getTime());
	if (elapsed >= SESSION_REFRESH_THRESHOLD_MS) {
		const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
		const refreshed = await extendSessionExpiry(database, tokenHash, expiresAt);
		if (refreshed) {
			setSessionCookie(cookies, token, expiresAt);
			return refreshed;
		}
	}

	return session;
}

/**
 * Deletes the session identified by the request's cookie and clears the cookie.
 * Returns true if a `sessions` row was actually removed (false when the cookie
 * was absent or already invalid). The cookie is cleared either way, so a stale
 * cookie can never leave the user stuck bouncing off route protection.
 */
export async function destroySession(database: Database, cookies: Cookies): Promise<boolean> {
	const token = cookies.get(SESSION_COOKIE_NAME);
	clearSessionCookie(cookies);
	if (!token) return false;
	return deleteSessionByTokenHash(database, hashSessionToken(token));
}
