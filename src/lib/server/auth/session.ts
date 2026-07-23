// Session cookie constant shared by the (app) route group's protection check
// and (later) the auth endpoints that create/verify sessions (US-B01–US-B05).
//
// This module intentionally does NOT validate the session against the
// database yet — the `sessions` table doesn't exist until US-B01. For now,
// `hasSessionCookie` only checks that the cookie is present and non-empty,
// which is enough to scaffold route protection (US-A03). Once US-B01/US-B05
// land, replace the presence check in `(app)/+layout.server.ts` with a real
// lookup (hash the cookie value, query `sessions`, check `expires_at`).
export const SESSION_COOKIE_NAME = 'session';

export function hasSessionCookie(cookies: { get: (name: string) => string | undefined }): boolean {
	const token = cookies.get(SESSION_COOKIE_NAME);
	return typeof token === 'string' && token.length > 0;
}
