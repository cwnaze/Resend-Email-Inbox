// The thread detail load (US-G01, tasks/prd-feature-thread-view.md).
//
// Auth is already guaranteed by `(app)/+layout.server.ts` — the single session
// choke point for this route group — so there is deliberately no second session
// check here.
//
// Opening a thread is also what marks it read (US-F02). That is deliberately a
// side effect in a GET load, which is why the list rows opt out of hover
// preloading (`data-sveltekit-preload-data="tap"` in `ThreadRow.svelte`): with
// the app-wide `hover` default, merely moving the pointer across the list would
// run this load and mark threads read the owner never opened. US-G04 owns the
// mark-read-on-view criterion formally; if it moves the mutation to a form
// action, that opt-out can go away.
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getThreadById, listThreadEmails, markThreadRead } from '$lib/server/db/emails';
import { absoluteTime, addressListLabel, bodyPlainText, senderLabel } from '$lib/inbox/format';

export const load: PageServerLoad = async ({ params }) => {
	const thread = await getThreadById(db, params.threadId);
	if (!thread) error(404, 'Thread not found');

	const messages = await listThreadEmails(db, params.threadId);
	// A thread all of whose messages are soft-deleted is not a viewable thread —
	// the inbox list drops it for the same reason (its inner join finds no
	// visible email), so a link to it can only come from a stale tab or a
	// bookmark. Answering 404 keeps the two views agreeing about what exists,
	// and it happens *before* `markThreadRead` so a thread with nothing to show
	// isn't silently mutated by a failed navigation.
	if (messages.length === 0) error(404, 'Thread not found');

	await markThreadRead(db, params.threadId);

	// The header shows the newest message's own subject, not `threads.subject`:
	// that column holds the *normalized* grouping key (lowercased, `Re:`-stripped
	// — see the threading notes), which is a matching key, not a human-readable
	// title.
	const newest = messages[messages.length - 1];

	// Bodies are reduced to plain text here rather than in the component so a
	// large HTML body doesn't cross the wire only to be de-tagged in the
	// browser, the same reason the list derives its snippets server-side.
	// US-G02 replaces this with a sandboxed `<iframe srcdoc>` and will need the
	// sanitized HTML on the wire instead.
	// No `threadId` here: it existed only for the placeholder page's debug line,
	// and `params.threadId` is what any later story should read anyway.
	return {
		subject: newest.subject,
		messages: messages.map((message) => ({
			id: message.id,
			sender: senderLabel(message.fromName, message.fromEmail),
			fromEmail: message.fromEmail,
			to: addressListLabel(message.toEmails),
			cc: addressListLabel(message.ccEmails),
			receivedAt: message.receivedAt,
			timestamp: absoluteTime(message.receivedAt),
			body: bodyPlainText(message.bodyText, message.bodyHtml)
		}))
	};
};
