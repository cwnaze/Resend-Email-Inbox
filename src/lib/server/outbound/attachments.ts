// Carrying an existing message's attachments onto a forward (US-H04).
//
// The story's rule is "re-associated, not re-uploaded by the user": the owner
// picked Forward, not a file dialog, so the bytes already exist — in R2, under
// the *original* message's key — and this module moves them onto the outgoing
// mail and then onto the new `emails` row.
//
// Like `inbound/attachments.ts`, the two provider-facing operations (read from
// R2, write to R2) are **injected** rather than imported: `server/r2` reads env
// at import time, and keeping it out of here is what lets a standalone `tsx`
// script drive this with stubs.
import { getAttachmentsByEmailId, insertAttachment, type Attachment } from '../db/attachments';
import type { Database } from '../db/types';
import { attachmentKeySlug } from '../inbound/attachments';

/**
 * The most a single forward may carry, summed across its files.
 *
 * Resend's own ceiling is 40 MB per message; this sits under it deliberately,
 * because the number that matters is not the provider's limit but the memory of
 * the serverless function that has to hold every file at once (the bytes are
 * read before the send and written back after it — see `+page.server.ts`). The
 * check runs against the stored `size_bytes` *before* anything is downloaded, so
 * an oversized forward costs one query rather than 25 MB of transfer.
 *
 * Base 1000, not 1024, because `formatFileSize` renders in base 1000 and this
 * number is shown to the owner when a forward is refused: 25 MiB reads back as
 * "26.2 MB", which is not a limit anybody set.
 */
export const MAX_FORWARDED_ATTACHMENT_BYTES = 25 * 1000 * 1000;

/** One file, in memory, on its way from the original message to the forward. */
export type ForwardedAttachment = {
	/** The source `attachments.id` — what makes the new object key unique. */
	sourceId: string;
	filename: string;
	contentType: string;
	bytes: Buffer;
};

export type LoadForwardedAttachmentsDeps = {
	/** Reads one object's bytes back out of R2 by key. */
	download: (key: string) => Promise<Buffer>;
};

export class ForwardedAttachmentsTooLargeError extends Error {
	readonly totalBytes: number;

	constructor(totalBytes: number) {
		super('Forwarded attachments exceed the size limit');
		this.name = 'ForwardedAttachmentsTooLargeError';
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
 * by the total, which `MAX_FORWARDED_ATTACHMENT_BYTES` already caps, but nothing
 * is gained by having every download in flight at once.
 */
export async function loadForwardedAttachments(
	db: Database,
	sourceEmailId: string,
	deps: LoadForwardedAttachmentsDeps
): Promise<ForwardedAttachment[]> {
	const rows = await getAttachmentsByEmailId(db, sourceEmailId);
	if (rows.length === 0) return [];

	const totalBytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
	if (totalBytes > MAX_FORWARDED_ATTACHMENT_BYTES) {
		throw new ForwardedAttachmentsTooLargeError(totalBytes);
	}

	const loaded: ForwardedAttachment[] = [];
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
 * The R2 key a forwarded copy is written under.
 *
 * A **copy**, not the original key shared by two rows. Sharing would make one
 * object the content of two messages, so deleting either one's blob (or the
 * bucket lifecycle reaching it) would silently empty the other — an aliasing bug
 * that only shows up long after the forward, when the original is gone. The
 * source attachment id is what makes the key unique within the new message, the
 * new email id namespaces it, and the slug is decoration.
 */
export function forwardedObjectKey(emailId: string, attachment: ForwardedAttachment): string {
	const slug = attachmentKeySlug(attachment.filename);
	const suffix = slug === '' ? '' : `-${slug}`;
	return `outbound/${emailId}/${attachment.sourceId}${suffix}`;
}

export type StoreForwardedAttachmentsDeps = {
	upload: (key: string, body: Buffer, contentType: string) => Promise<unknown>;
	/** Undoes an upload whose row then failed to insert (see `inbound/attachments.ts`). */
	remove?: (key: string) => Promise<unknown>;
};

export type StoreForwardedAttachmentsResult = {
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
export async function storeForwardedAttachments(
	db: Database,
	emailId: string,
	attachments: ForwardedAttachment[],
	deps: StoreForwardedAttachmentsDeps
): Promise<StoreForwardedAttachmentsResult> {
	const stored: Attachment[] = [];
	const failed: string[] = [];

	for (const attachment of attachments) {
		const key = forwardedObjectKey(emailId, attachment);
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
