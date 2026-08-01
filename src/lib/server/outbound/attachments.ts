// Attachments on their way onto an outgoing message (US-H04, US-H05).
//
// Two sources, one destination. A **forward** re-associates an existing
// message's files ("not re-uploaded by the user": the owner picked Forward, not
// a file dialog, so the bytes already exist in R2 under the *original* message's
// key). A **picked** file was uploaded straight to R2 by the browser before the
// send and arrives here through `outbound/uploads.ts`. From `OutboundAttachment`
// down, the two are the same thing: bytes with a name, headed for the send call
// and then for one `attachments` row against the new `emails` row.
//
// Like `inbound/attachments.ts`, the two provider-facing operations (read from
// R2, write to R2) are **injected** rather than imported: `server/r2` reads env
// at import time, and keeping it out of here is what lets a standalone `tsx`
// script drive this with stubs.
import { getAttachmentsByEmailId, insertAttachment, type Attachment } from '../db/attachments';
import type { Database } from '../db/types';
import { attachmentKeySlug } from '../inbound/attachments';
// Relative, not `$lib/...`: `verify-outbound-send.mts` runs under bare `tsx`,
// which has no Vite alias resolution (CLAUDE.md).
import { MAX_ATTACHMENT_TOTAL_BYTES } from '../../compose/attachments';

// Re-exported so the server side of this feature has one import for it. The
// definition lives in the pure module because the *browser* enforces it too.
export { MAX_ATTACHMENT_TOTAL_BYTES };

/** One file, in memory, on its way onto an outgoing message. */
export type OutboundAttachment = {
	/**
	 * What makes this file's key unique within the new message: the source
	 * `attachments.id` for a forward, the pending upload's id for a picked file.
	 */
	sourceId: string;
	filename: string;
	contentType: string;
	bytes: Buffer;
};

export type LoadForwardedAttachmentsDeps = {
	/** Reads one object's bytes back out of R2 by key. */
	download: (key: string) => Promise<Buffer>;
};

export class AttachmentsTooLargeError extends Error {
	readonly totalBytes: number;

	constructor(totalBytes: number) {
		super('Attachments exceed the size limit');
		this.name = 'AttachmentsTooLargeError';
		this.totalBytes = totalBytes;
	}
}

/**
 * Reads every attachment of the message being forwarded into memory.
 *
 * **Failures here are fatal, unlike inbound ingestion's.** A missing object at
 * ingest means one file is absent from a message that has already arrived; a
 * missing object here would mean sending a forward whose whole point — "here is
 * the file" — is silently gone, and mail cannot be un-sent. So this throws and
 * the action refuses the send while the draft is still on screen.
 *
 * Sequential for the reason `storeInboundAttachments` is: peak memory is bounded
 * by the total, which `MAX_ATTACHMENT_TOTAL_BYTES` already caps, but nothing
 * is gained by having every download in flight at once.
 */
export async function loadForwardedAttachments(
	db: Database,
	sourceEmailId: string,
	deps: LoadForwardedAttachmentsDeps,
	/**
	 * Bytes already committed to this message by files from the *other* source
	 * (US-H05: the owner can add their own files to a forward). The limit is per
	 * message, not per source — Resend's ceiling and the function's memory are
	 * both counted once.
	 */
	existingBytes: number = 0
): Promise<OutboundAttachment[]> {
	const rows = await getAttachmentsByEmailId(db, sourceEmailId);
	if (rows.length === 0) return [];

	const totalBytes = existingBytes + rows.reduce((sum, row) => sum + row.sizeBytes, 0);
	if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
		throw new AttachmentsTooLargeError(totalBytes);
	}

	const loaded: OutboundAttachment[] = [];
	for (const row of rows) {
		loaded.push({
			sourceId: row.id,
			filename: row.filename,
			contentType: row.contentType,
			bytes: await deps.download(row.r2ObjectKey)
		});
	}
	return loaded;
}

/**
 * The R2 key this message's copy of a file is written under.
 *
 * Always a **copy**, never the source key shared by two rows — that holds for
 * both sources. Sharing would make one object the content of two messages, so
 * deleting either one's blob (or the bucket lifecycle reaching it) would
 * silently empty the other, an aliasing bug that only shows up long after the
 * fact. For a picked file (US-H05) it also gets the object out of
 * `outbound/pending/`, where an unclaimed upload can be swept: a settled
 * attachment must not live under a prefix whose whole meaning is "not yet
 * claimed by a send".
 *
 * `sourceId` is what makes the key unique within the new message, the new email
 * id namespaces it, and the slug is decoration.
 */
export function outboundObjectKey(emailId: string, attachment: OutboundAttachment): string {
	const slug = attachmentKeySlug(attachment.filename);
	const suffix = slug === '' ? '' : `-${slug}`;
	return `outbound/${emailId}/${attachment.sourceId}${suffix}`;
}

export type StoreOutboundAttachmentsDeps = {
	upload: (key: string, body: Buffer, contentType: string) => Promise<unknown>;
	/** Undoes an upload whose row then failed to insert (see `inbound/attachments.ts`). */
	remove?: (key: string) => Promise<unknown>;
};

export type StoreOutboundAttachmentsResult = {
	stored: Attachment[];
	/** Source attachment ids whose copy could not be recorded — logged, not retried. */
	failed: string[];
};

/**
 * Writes the forwarded copies into R2 and records one `attachments` row each.
 *
 * **Runs after the send, and its failures are best-effort**, which is the exact
 * opposite of `loadForwardedAttachments` above and for the same reason the whole
 * action is ordered validate → send → store: by this point the mail with these
 * files attached is already out. A failure here costs the owner's own copy of a
 * file the recipient has, and nothing it reports may read as "not sent".
 */
export async function storeOutboundAttachments(
	db: Database,
	emailId: string,
	attachments: OutboundAttachment[],
	deps: StoreOutboundAttachmentsDeps
): Promise<StoreOutboundAttachmentsResult> {
	const stored: Attachment[] = [];
	const failed: string[] = [];

	for (const attachment of attachments) {
		const key = outboundObjectKey(emailId, attachment);
		let uploaded = false;
		try {
			await deps.upload(key, attachment.bytes, attachment.contentType);
			uploaded = true;
			stored.push(
				await insertAttachment(db, {
					emailId,
					filename: attachment.filename,
					contentType: attachment.contentType,
					sizeBytes: attachment.bytes.byteLength,
					r2ObjectKey: key
				})
			);
		} catch (err) {
			// Ids only, never the filename: that is user content and this line lands
			// in the platform's function logs.
			failed.push(attachment.sourceId);
			console.error(`forwarded attachment failed (email ${emailId}, key ${key}):`, err);
			if (uploaded && deps.remove) {
				try {
					await deps.remove(key);
				} catch (removeErr) {
					console.error(`forwarded attachment cleanup failed (key ${key}):`, removeErr);
				}
			}
		}
	}

	return { stored, failed };
}
