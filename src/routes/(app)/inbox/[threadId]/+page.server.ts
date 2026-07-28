// Marking a thread read on open (US-F02).
//
// The full thread render is US-G01; this load exists now only so that opening a
// thread clears its unread state. Auth is already guaranteed by
// `(app)/+layout.server.ts`.
//
// This is deliberately a side effect in a GET load, which is why the list rows
// opt out of hover preloading (`data-sveltekit-preload-data="tap"` in
// `ThreadRow.svelte`): with the app-wide `hover` default, merely moving the
// pointer across the list would run this load and mark threads read the owner
// never opened. If US-G01 moves this to a form action instead, that opt-out can
// go away.
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getThreadById, markThreadRead } from '$lib/server/db/emails';

export const load: PageServerLoad = async ({ params }) => {
	const thread = await getThreadById(db, params.threadId);
	if (!thread) error(404, 'Thread not found');

	await markThreadRead(db, params.threadId);

	return {
		threadId: thread.id,
		// Normalized (lowercased, `Re:`-stripped) — US-G01 renders the newest
		// email's own subject instead.
		subject: thread.subject
	};
};
