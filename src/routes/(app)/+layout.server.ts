import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { SESSION_COOKIE_NAME, clearSessionCookie, validateSession } from '$lib/server/auth/session';
import { db } from '$lib/server/db';

// Single choke point protecting every route under the (app) group (US-A03,
// real validation as of US-B05): hash the cookie token, look it up in
// `sessions`, reject if missing/unknown/expired. New protected pages added
// under (app)/ inherit this — never add a second parallel check.
export const load: LayoutServerLoad = async ({ cookies }) => {
	const session = await validateSession(db, cookies);

	if (!session) {
		// Clear the cookie on the way out so a stale/expired token isn't re-sent on
		// every subsequent request, and so the browser stops looking logged in.
		// Only when one was actually sent — a first-ever visit has no session
		// cookie, and deleting a cookie that was never there just burns a
		// Set-Cookie header on the most common unauthenticated path.
		if (cookies.get(SESSION_COOKIE_NAME)) {
			clearSessionCookie(cookies);
		}
		redirect(302, '/login');
	}
};
