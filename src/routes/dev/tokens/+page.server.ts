import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Design-token QA page — dev-only, never reachable in a production build.
export const load: PageServerLoad = () => {
	if (!dev) {
		error(404, 'Not found');
	}
};
