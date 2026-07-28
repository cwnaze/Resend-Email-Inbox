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
import { prepareEmailHtml } from '$lib/server/inbox/html';

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

	// Body rendering (US-G02): an HTML body is sanitized and has its remote images
	// blocked here, on the server, and crosses the wire as markup for the
	// component's sandboxed iframe. A message with no HTML body sends plain text
	// instead — no iframe is mounted for it — and the plain text is de-tagged
	// here rather than in the component so a large body isn't shipped only to be
	// reduced in the browser (same reason the list derives its snippets
	// server-side).
	//
	// HTML wins when both are present *and the HTML actually says something*: it
	// is what the sender composed, and the `text/plain` alternative is usually a
	// degraded copy of it. That is the opposite precedence from
	// `bodySnippet`/`bodyPlainText`, which prefer text because a *preview* wants
	// the cheapest readable form, not the richest.
	//
	// The "does the HTML actually show anything" qualifier is load-bearing, not
	// defensive, and it has to cut both ways or a message becomes unreachable:
	// HTML that is only a spacer and a tracking pixel renders *blank*, so
	// preferring it would replace a readable text body with an empty frame and a
	// "1 remote image blocked" notice; but an image-only retail email *is* its hero
	// image, and its text part is a "view in browser" stub, so demanding text would
	// throw the real message away just as badly.
	//
	// No `threadId` here: it existed only for the placeholder page's debug line,
	// and `params.threadId` is what any later story should read anyway.
	return {
		subject: newest.subject,
		messages: messages.map((message) => {
			const prepared = prepareEmailHtml(message.bodyHtml);
			// Note `message.bodyHtml` is passed through rather than `null`: when the
			// HTML branch is *not* taken, `bodyPlainText`'s own de-tagged-HTML
			// fallback is still the best rendering left for a message with no text
			// part (a body that sanitized away entirely, or blank HTML).
			const text = bodyPlainText(message.bodyText, message.bodyHtml);
			// Render the HTML when it has something to show: readable text, or an image
			// that isn't a tracking pixel. When it has neither, the text part is the
			// message — and if there is no text part either, `html` stays null so
			// `ThreadMessage` renders its explicit "no body" line instead of an empty
			// 24px frame with nothing in it and nothing to explain it.
			const useHtml = prepared !== null && prepared.hasVisibleContent;
			return {
				id: message.id,
				sender: senderLabel(message.fromName, message.fromEmail),
				fromEmail: message.fromEmail,
				to: addressListLabel(message.toEmails),
				cc: addressListLabel(message.ccEmails),
				receivedAt: message.receivedAt,
				timestamp: absoluteTime(message.receivedAt),
				html: useHtml ? prepared.html : null,
				blockedImageCount: useHtml ? prepared.blockedImageCount : 0,
				body: useHtml ? '' : text
			};
		})
	};
};
