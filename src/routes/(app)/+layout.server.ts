import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME } from '$lib/server/auth/session';
import type { LayoutServerLoad } from './$types';

// Scaffold-level session gate for every route under the (app) group.
//
// This story (US-A03) only checks that a session cookie is *present* --
// there is no `sessions` table lookup here yet (that table lands in
// US-D01, and full "is this token valid/non-expired" verification is
// implemented in US-B05). Any presence of the cookie is treated as a
// placeholder "authenticated" signal so every later mailbox feature has a
// protected route group to build inside from day one.
export const load: LayoutServerLoad = ({ cookies }) => {
	const sessionToken = cookies.get(SESSION_COOKIE_NAME);

	if (!sessionToken) {
		redirect(303, '/login');
	}
};
