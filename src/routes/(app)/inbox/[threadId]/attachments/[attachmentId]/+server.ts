// Attachment download (US-G03, tasks/prd-feature-thread-view.md).
//
// The R2 bucket is private and there is no static public URL (see
// `docs/notes/infrastructure.md`), so the browser cannot link at an object
// directly. This endpoint is the indirection: it resolves an attachment id
// *within its thread*, presigns a short-lived GET, and 302s the browser to R2.
// The bytes never pass through this function — a serverless invocation has a
// 4.5MB response ceiling and a 10s budget (Architecture PRD), and proxying a
// 20MB attachment would blow both.
//
// **Presigning happens here, per click, and deliberately NOT in the thread
// load.** A signed URL expires, and a thread page is exactly the kind of page
// that sits open in a tab for hours; a URL minted at load time would be dead by
// the time the reader clicked it, with nothing to explain why. Minting on demand
// also means a URL is only ever created for a file someone actually asked for,
// so a thread of twenty attachments costs zero signatures to render.
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { getThreadAttachment } from '$lib/server/db/attachments';
import { validateSession } from '$lib/server/auth/session';
import { getR2SignedDownloadUrl } from '$lib/server/r2';
import { attachmentContentDisposition, downloadContentType } from '$lib/server/inbox/download';

// Short, because the redirect is followed immediately. The URL still ends up in
// the browser's history and in R2's access logs, so the window in which a leaked
// copy is usable should be a click, not the 15-minute default.
const DOWNLOAD_URL_EXPIRY_SECONDS = 60;

/**
 * `(app)/+layout.server.ts` is the route group's auth choke point, but **a
 * layout load does not run for a `+server.ts` request** — only for pages. So
 * this endpoint checks the session itself. That is not the "second parallel
 * check" the auth notes forbid (which is about pages, where the check would be
 * redundant); without it, this route would be the one unauthenticated hole in
 * the group, handing out signed URLs to the owner's mail to anyone who guesses a
 * pair of UUIDs. Any future `+server.ts` under `(app)/` needs the same line.
 *
 * A missing session answers 401 rather than redirecting to `/login`: this is
 * fetched as a document by a link click, and a login page delivered as the
 * response to a download is a worse answer than a plain refusal.
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const session = await validateSession(db, cookies);
	if (!session) error(401, 'Not signed in');

	// Scoped to the thread and to a non-deleted email, so this cannot serve a
	// file the thread view itself would refuse to list.
	const attachment = await getThreadAttachment(db, params.threadId, params.attachmentId);
	if (!attachment) error(404, 'Attachment not found');

	// Both response overrides are part of the signature, so the filename the
	// browser saves under is fixed by this app rather than by the stored object's
	// metadata — and both are built from sender-controlled columns, which is why
	// they go through the escaping helpers rather than being interpolated.
	const url = await getR2SignedDownloadUrl(attachment.r2ObjectKey, {
		expiresInSeconds: DOWNLOAD_URL_EXPIRY_SECONDS,
		contentDisposition: attachmentContentDisposition(attachment.filename),
		contentType: downloadContentType(attachment.contentType)
	});

	// 302, not 301: the target is single-use and expires in a minute, so it must
	// never be cached by the browser or by anything between here and it.
	redirect(302, url);
};
