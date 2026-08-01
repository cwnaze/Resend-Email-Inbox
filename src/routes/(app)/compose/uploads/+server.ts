// Presigned uploads for compose attachments (US-H05).
//
// `POST` mints a short-lived PUT URL into the private bucket; `DELETE` drops a
// pending object the owner removed from the list before sending. The bytes never
// pass through this function in either direction — a serverless invocation caps
// its request body around 4.5 MB, so a 25 MB attachment posted at the app could
// not arrive at all. See `server/outbound/uploads.ts` for what the *send* then
// refuses to take on trust.
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { validateSession } from '$lib/server/auth/session';
import { deleteFromR2, getR2SignedUploadUrl } from '$lib/server/r2';
import {
	MAX_ATTACHMENT_TOTAL_BYTES,
	composeAttachmentFilename,
	isPendingAttachmentKey
} from '$lib/compose/attachments';
import { pendingAttachmentKey } from '$lib/server/outbound/uploads';

// Long enough for a 25 MB file on a slow connection, short enough that a URL
// left in a tab overnight is not still a write handle into the bucket.
const UPLOAD_URL_EXPIRY_SECONDS = 60 * 10;

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * A content type safe to put in a signature and store on the object.
 *
 * The browser reports `File.type`, which is derived from the file's extension
 * and is therefore attacker-chosen in the general case. Anything that is not a
 * plain `type/subtype` token — parameters, control characters, a header
 * injection attempt — is replaced rather than rejected: the type is a display
 * and download detail, and refusing an upload over it would be a dead end the
 * owner cannot fix.
 */
function safeContentType(raw: unknown): string {
	if (typeof raw !== 'string') return FALLBACK_CONTENT_TYPE;
	const trimmed = raw.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(trimmed)
		? trimmed
		: FALLBACK_CONTENT_TYPE;
}

/**
 * `(app)/+layout.server.ts` does not run for a `+server.ts` request, so both
 * handlers below validate the session themselves — the cross-cutting rule in
 * CLAUDE.md. Without it this would hand anyone who found the path a write URL
 * into the owner's bucket.
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const session = await validateSession(db, cookies);
	if (!session) error(401, 'Not signed in');

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Expected a JSON body');
	}
	if (typeof body !== 'object' || body === null) error(400, 'Expected a JSON body');
	const { filename, contentType, sizeBytes } = body as Record<string, unknown>;

	// A single file over the whole-message limit can never be part of a valid
	// send, so it is refused before an object exists rather than after 25 MB of
	// transfer. This is the client's claimed size and therefore only a courtesy —
	// the send re-derives every size from R2's own HEAD, which is where the limit
	// is actually enforced.
	if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
		error(400, 'Expected a size');
	}
	if (sizeBytes > MAX_ATTACHMENT_TOTAL_BYTES) error(413, 'That file is too large to attach');

	// The key is minted here and never accepted from the caller — that is the
	// whole basis on which the send is willing to attach the object later.
	const key = pendingAttachmentKey(
		crypto.randomUUID(),
		composeAttachmentFilename(typeof filename === 'string' ? filename : '')
	);
	const resolvedContentType = safeContentType(contentType);

	return json({
		key,
		contentType: resolvedContentType,
		// Signed with the content type, so the browser's PUT must send exactly this
		// header — which pins the stored object's type to the one approved here.
		uploadUrl: await getR2SignedUploadUrl(key, resolvedContentType, UPLOAD_URL_EXPIRY_SECONDS)
	});
};

/**
 * Removes a file from the draft: the owner clicked Remove, so the object it
 * already uploaded has no send coming for it.
 *
 * Confined to `outbound/pending/` keys by `isPendingAttachmentKey`, which is what
 * keeps this from being a delete-any-object endpoint — a stored attachment's key
 * (`outbound/<email id>/…`, `inbound/…`) never matches, so no message's file can
 * be erased through here.
 *
 * A failed delete is not reported as a failure: the file is gone from the draft
 * either way, and the cost is one orphan under the prefix that exists to hold
 * unclaimed uploads.
 */
export const DELETE: RequestHandler = async ({ request, cookies }) => {
	const session = await validateSession(db, cookies);
	if (!session) error(401, 'Not signed in');

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Expected a JSON body');
	}
	const key = (body as { key?: unknown } | null)?.key;
	if (typeof key !== 'string' || !isPendingAttachmentKey(key)) error(400, 'Not a pending upload');

	try {
		await deleteFromR2(key);
	} catch (err) {
		console.error(`pending attachment delete failed (key ${key}):`, err);
	}
	return new Response(null, { status: 204 });
};
