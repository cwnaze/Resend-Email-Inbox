// The thread detail load (US-G01, tasks/prd-feature-thread-view.md).
//
// Auth is already guaranteed by `(app)/+layout.server.ts` — the single session
// choke point for this route group — so there is deliberately no second session
// check here.
//
// Opening a thread is also what marks it read (US-F02, and US-G04's first
// criterion). That is deliberately a side effect in a GET load — "the page was
// loaded" is the exact event the criterion names, and there is no user gesture
// to hang a POST on — which is why the list rows opt out of hover preloading
// (`data-sveltekit-preload-data="tap"` in `ThreadRow.svelte`): with the app-wide
// `hover` default, merely moving the pointer across the list would run this load
// and mark threads read the owner never opened. Keep that opt-out as long as the
// mutation lives here.
import { error, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	getThreadById,
	listThreadEmails,
	markThreadRead,
	softDeleteThreadEmail
} from '$lib/server/db/emails';
import { listAttachmentsForEmails } from '$lib/server/db/attachments';
import {
	absoluteTime,
	addressListLabel,
	bodyPlainText,
	formatFileSize,
	senderLabel
} from '$lib/inbox/format';
import { prepareEmailHtml } from '$lib/server/inbox/html';
import { validateSession } from '$lib/server/auth/session';

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

	// Attachments for every message in one query (US-G03), grouped here rather
	// than fetched per message: one round trip against a remote Turso database
	// instead of one per message. `r2_object_key` is deliberately **not** carried
	// into the returned shape — the key is an internal storage detail, and the
	// browser needs only the attachment id to hit the download endpoint, which
	// looks the key up server-side.
	const attachmentsByEmailId = new Map<string, { id: string; filename: string; size: string }[]>();
	for (const attachment of await listAttachmentsForEmails(
		db,
		messages.map((message) => message.id)
	)) {
		const list = attachmentsByEmailId.get(attachment.emailId) ?? [];
		list.push({
			id: attachment.id,
			filename: attachment.filename,
			size: formatFileSize(attachment.sizeBytes)
		});
		attachmentsByEmailId.set(attachment.emailId, list);
	}

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
	// `threadId` is back in the payload as of US-G03, for a different reason than
	// the placeholder page's old debug line: `AttachmentList` builds each download
	// href with `resolve('/(app)/inbox/[threadId]/attachments/[attachmentId]', …)`,
	// which needs the thread id at render time.
	return {
		threadId: params.threadId,
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
			// Two independent decisions, deliberately not one either/or — that either/or
			// was the source of a whole family of bugs.
			//
			// A frame is mounted when there is anything a frame could show: real text, or
			// an image that could actually display something. Deliberately *not* "any
			// image we blocked": a body whose only image is a declared 1×1 tracker
			// mounted a blank frame captioned "1 remote image blocked", whose only
			// button existed to fire the beacon. Nothing to frame — an empty body, or one
			// whose only image is an unresolvable `cid:` reference — leaves `html` null
			// so the honest "no body" line can render instead.
			//
			// The text part is dropped **only** when the HTML has real text of its own.
			// It is never dropped on the strength of the image heuristic, because that
			// heuristic is always one attribute away from being wrong (`width="17"` on a
			// tracking pixel), and being wrong used to mean a readable message with no
			// way to reach it. So a frame whose content we cannot vouch for is shown
			// *with* the text beneath it, and the reader loses nothing either way.
			const showFrame = prepared !== null && (prepared.hasVisibleText || prepared.hasLoadableImage);
			const showText = prepared === null || !prepared.hasVisibleText;

			return {
				id: message.id,
				sender: senderLabel(message.fromName, message.fromEmail),
				fromEmail: message.fromEmail,
				to: addressListLabel(message.toEmails),
				cc: addressListLabel(message.ccEmails),
				receivedAt: message.receivedAt,
				timestamp: absoluteTime(message.receivedAt),
				html: showFrame ? prepared!.html : null,
				blockedImageCount: showFrame ? prepared!.blockedImageCount : 0,
				body: showText ? text : '',
				attachments: attachmentsByEmailId.get(message.id) ?? []
			};
		})
	};
};

export const actions = {
	/**
	 * Soft-deletes one message of this thread (US-G04, FR-4).
	 *
	 * A form action, not a `+server.ts` endpoint or a link: it mutates, so it has
	 * to be a POST, and as an action it works with no JavaScript and re-runs this
	 * page's `load` on the way out — which is what makes the message disappear
	 * from the view without a second "remove it from the list" code path that
	 * could disagree with `listThreadEmails` about what is visible.
	 *
	 * **This action validates the session itself.** `(app)/+layout.server.ts` is
	 * the group's choke point for *rendering*, but SvelteKit runs an action
	 * **before** any `load`, so a POST here would have already deleted the
	 * message by the time the layout redirected an anonymous caller to `/login`.
	 * Same trap as the attachment `+server.ts` (see `docs/notes/auth.md`), same
	 * fix, and the same rule for anything mutating added under `(app)/` later.
	 * 401 rather than a redirect: this is a form submit against a known thread,
	 * and answering it with a login page pretending the delete happened would be
	 * worse than refusing.
	 */
	deleteMessage: async ({ cookies, params, request }) => {
		const session = await validateSession(db, cookies);
		if (!session) error(401, 'Not authenticated');

		const form = await request.formData();
		const emailId = form.get('emailId');
		if (typeof emailId !== 'string' || emailId === '') error(400, 'Missing message id');

		// `threadId` goes into the query, so this can only ever delete a message of
		// the thread whose URL was posted to.
		const result = await softDeleteThreadEmail(db, params.threadId, emailId);
		if (!result.found) error(404, 'Message not found');

		// Both branches redirect (303, so the browser re-issues a GET) rather than
		// returning data, which is what keeps a refresh from re-posting the delete
		// and keeps `?/deleteMessage` out of the address bar — this form is
		// deliberately not `use:enhance`d, so without the redirect the action's own
		// POST URL is what the reader is left sitting on.
		//
		// An emptied thread goes to the list, not back to itself: `load` rejects a
		// thread with no visible messages, so returning here would bounce the owner
		// off a 404 boundary for a delete that succeeded.
		if (result.visibleRemaining === 0) redirect(303, resolve('/(app)/inbox'));
		redirect(303, resolve('/(app)/inbox/[threadId]', { threadId: params.threadId }));
	}
} satisfies Actions;
