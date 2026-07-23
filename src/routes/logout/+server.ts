import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SESSION_COOKIE_NAME } from '$lib/server/auth/session';

// Logout action for the app shell's top bar. Full session invalidation
// (deleting the corresponding row from the `sessions` table) lands in
// US-B05 once that table is actually read from; for now this just clears
// the cookie the (app) route group's presence check relies on, which is
// enough to end the session as far as `hasSessionCookie` is concerned.
export const POST: RequestHandler = async ({ cookies }) => {
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
	redirect(303, '/login');
};
