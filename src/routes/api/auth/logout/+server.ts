// POST /api/auth/logout (US-B05)
//
// Deletes the caller's `sessions` row and clears the session cookie, then
// redirects to /login. Moved here from `/logout` in US-B05 to sit alongside the
// other two auth endpoints (`request-code`, `verify-code`) and to match
// tasks/prd-auth.md US-B05.
//
// Server-side deletion is the point of FR-8 (sessions are revocable records,
// not stateless tokens): clearing only the cookie would leave a valid row that
// a copy of the token could still use.
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { destroySession } from '$lib/server/auth/session';
import { db } from '$lib/server/db';

export const POST: RequestHandler = async ({ cookies }) => {
	await destroySession(db, cookies);
	// 303 so the browser follows with GET after this POST (the app shell's
	// logout control is a plain, JS-free <form method="POST">).
	redirect(303, '/login');
};
