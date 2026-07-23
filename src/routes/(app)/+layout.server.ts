import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { hasSessionCookie } from '$lib/server/auth/session';

// Protects every route under the (app) group. Full session validation
// (hashing the cookie token and checking it against the `sessions` table)
// lands in US-B05 once auth is implemented; for now this scaffolds the
// redirect behavior so mailbox routes are protected from day one.
export const load: LayoutServerLoad = async ({ cookies }) => {
	if (!hasSessionCookie(cookies)) {
		redirect(302, '/login');
	}
};
