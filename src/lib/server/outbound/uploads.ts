// Files the owner picked in the compose screen, on their way to a send (US-H05).
//
// **The bytes never travel through this app.** The browser asks
// `POST /compose/uploads` for a presigned PUT, uploads straight into R2, and
// submits only the object *key* with the form. That is not an optimization: the
// app is deployed on Vercel, whose functions cap a request body around 4.5 MB,
// so a 25 MB attachment posted through the form action could not arrive at all.
//
// What it costs is that the key is request input, and this module is the place
// that refuses to take the client's word for anything:
//
// - the **key** must match `isPendingAttachmentKey` — a key this app minted for
//   a pending upload, never an `inbound/…` object belonging to a message;
// - the **size** and **content type** come from R2's own HEAD, never from the
//   form, so the 25 MB limit cannot be understated into compliance;
// - the **filename** is the one thing that can only come from the client, and it
//   is sanitized (`composeAttachmentFilename`).
//
// Like `attachments.ts` next door, the R2 operations are **injected**: `server/r2`
// reads env at import time, and keeping it out of here is what lets a standalone
// `tsx` script drive this with stubs.
import {
	MAX_ATTACHMENT_TOTAL_BYTES,
	PENDING_ATTACHMENT_PREFIX,
	isPendingAttachmentKey,
	type PendingAttachment
} from '../../compose/attachments';
import { attachmentKeySlug } from '../inbound/attachments';
import { AttachmentsTooLargeError, type OutboundAttachment } from './attachments';

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * The key a pending upload lands under, minted here and never accepted from a
 * caller.
 *
 * `uploadId` is a UUID rather than the filename because two picked files can
 * share a name (and because a name the client chose has no business deciding
 * where an object lands in the bucket — the same rule
 * `inbound/attachments.ts` follows). The slug is decoration, so a key is
 * recognizable when browsing R2, and it is the reason
 * `isPendingAttachmentKey`'s pattern ends in the slug alphabet.
 */
export function pendingAttachmentKey(uploadId: string, filename: string): string {
	const slug = attachmentKeySlug(filename);
	return `${PENDING_ATTACHMENT_PREFIX}${uploadId}/${slug}`;
}

/** The upload id embedded in a pending key — the `sourceId` of the file it becomes. */
export function pendingUploadId(key: string): string {
	return key.slice(PENDING_ATTACHMENT_PREFIX.length).split('/')[0];
}

export type LoadPendingAttachmentsDeps = {
	/** What R2 says the object is: its real size and stored content type. */
	head: (key: string) => Promise<{ sizeBytes: number; contentType: string | null }>;
	/** Reads one object's bytes back out of R2 by key. */
	download: (key: string) => Promise<Buffer>;
};

/**
 * Reads every picked file into memory, ready for the send call.
 *
 * **Failures here are fatal**, exactly as they are for a forward and for the
 * same reason: mail cannot be un-sent, and a message that says "see attached"
 * and doesn't is worse than a refused send with the draft still on screen. An
 * object that has vanished (an expired pending upload, a PUT that never
 * completed) throws out of `head` and the action refuses the send.
 *
 * The size check runs over **all** the HEADs before **any** download, so an
 * oversized selection costs a few metadata requests rather than 25 MB of
 * transfer — the same shape as `loadForwardedAttachments`'s pre-download check
 * against the stored `size_bytes`.
 *
 * Sequential downloads, per `storeInboundAttachments`: peak memory is bounded by
 * the total, which the limit already caps, but nothing is gained by having every
 * transfer in flight at once.
 */
export async function loadPendingAttachments(
	pending: PendingAttachment[],
	deps: LoadPendingAttachmentsDeps
): Promise<OutboundAttachment[]> {
	if (pending.length === 0) return [];

	const described: { attachment: PendingAttachment; contentType: string }[] = [];
	let totalBytes = 0;
	for (const attachment of pending) {
		// Belt and braces: `parsePendingAttachments` has already dropped anything
		// that isn't a key this app minted, and this asserts it at the last moment
		// before the key reaches R2.
		if (!isPendingAttachmentKey(attachment.key)) {
			throw new Error(`refusing a non-pending attachment key: ${attachment.key}`);
		}
		const { sizeBytes, contentType } = await deps.head(attachment.key);
		totalBytes += sizeBytes;
		described.push({ attachment, contentType: contentType || FALLBACK_CONTENT_TYPE });
	}

	if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
		throw new AttachmentsTooLargeError(totalBytes);
	}

	const loaded: OutboundAttachment[] = [];
	for (const { attachment, contentType } of described) {
		loaded.push({
			sourceId: pendingUploadId(attachment.key),
			filename: attachment.filename,
			contentType,
			bytes: await deps.download(attachment.key)
		});
	}
	return loaded;
}

/**
 * The bytes a selection will add to the message, without downloading any of it.
 *
 * Split out from `loadPendingAttachments` so the *forward* half of a send can be
 * checked against the same per-message limit before it starts downloading (see
 * `loadForwardedAttachments`'s `existingBytes`).
 */
export function loadedTotalBytes(attachments: OutboundAttachment[]): number {
	return attachments.reduce((sum, attachment) => sum + attachment.bytes.byteLength, 0);
}

/**
 * Drops the pending objects a send has finished with.
 *
 * Best-effort and always after the send: `storeOutboundAttachments` writes each
 * file to a **copy** under `outbound/<email id>/…` (see its key comment), so by
 * the time this runs the pending object is a duplicate. A failure here leaks an
 * object into `outbound/pending/`, which is exactly what that prefix is for —
 * it must never turn a delivered message into an error.
 */
export async function discardPendingAttachments(
	keys: string[],
	remove: (key: string) => Promise<unknown>
): Promise<void> {
	for (const key of keys) {
		try {
			await remove(key);
		} catch (err) {
			console.error(`pending attachment cleanup failed (key ${key}):`, err);
		}
	}
}
