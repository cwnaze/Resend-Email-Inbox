// Attachment extraction for inbound ingestion (US-E05,
// tasks/prd-feature-inbound-processing.md).
//
// The `email.received` webhook carries attachment *metadata* only, and so does
// the fetched received-email record — the bytes live behind Resend's
// Attachments API. So each attachment is a separate download, and each download
// is streamed straight into R2; nothing is ever written to a database column
// (FR-5).
//
// The two provider-facing operations (fetch the bytes, put them in R2) are
// **injected** rather than imported: `server/email/resend.ts` and `server/r2`
// both read env, and keeping them out of this module means it stays drivable
// from a standalone `tsx` script with stubs, like `parse.ts` and `store.ts`.
import { insertAttachment, type Attachment } from '../db/attachments';
import type { Database } from '../db/types';
import type { ReceivedEmailRecord } from './parse';

export type InboundAttachmentMetadata = ReceivedEmailRecord['attachments'][number];

export type AttachmentBytes = { bytes: Uint8Array; contentType?: string | null };

export type StoreInboundAttachmentsDeps = {
	/** Downloads one attachment's content by Resend's ids. */
	download: (resendEmailId: string, attachmentId: string) => Promise<AttachmentBytes>;
	/** Uploads bytes to R2 under `key`. */
	upload: (key: string, body: Buffer, contentType: string) => Promise<unknown>;
};

export type StoreInboundAttachmentsResult = {
	stored: Attachment[];
	/** Attachment ids that could not be stored — logged, not retried (v1). */
	failed: string[];
};

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * A filesystem-safe display filename.
 *
 * Resend reports `filename` as nullable, and a sender controls its value: it can
 * carry path separators, NUL bytes or nothing at all. This is stored in a text
 * column and later offered to a browser as a download name, so it is reduced to
 * a single path segment here rather than at render time.
 */
export function attachmentFilename(attachment: InboundAttachmentMetadata): string {
	// eslint-disable-next-line no-control-regex -- stripping exactly these bytes is the point
	const raw = (attachment.filename ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
	// Keep only the last path segment: `../../etc/passwd` must not survive as a
	// name that some future download handler treats as a path.
	const base = raw.split(/[/\\]/).pop()?.trim() ?? '';
	if (base === '' || base === '.' || base === '..') return `attachment-${attachment.id}`;
	return base.slice(0, 255);
}

/**
 * The R2 object key for one attachment, namespaced by Resend's email id.
 *
 * Resend's attachment id — not the filename — is what makes the key unique:
 * two attachments on one email can share a filename, and a sender-supplied name
 * has no business deciding where an object lands in the bucket. The filename is
 * appended, slugified, purely so a key is recognizable when browsing R2.
 */
export function attachmentObjectKey(
	resendEmailId: string,
	attachment: InboundAttachmentMetadata
): string {
	const slug = attachmentFilename(attachment)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
	const suffix = slug === '' ? '' : `-${slug}`;
	return `inbound/${resendEmailId}/${attachment.id}${suffix}`;
}

/**
 * Downloads every attachment of a received email into R2 and records one
 * `attachments` row per file.
 *
 * Each attachment is handled independently and **failures are swallowed** (per
 * the story's third acceptance criterion): the email itself is already stored
 * and acknowledged, so throwing here would make Resend redeliver a message
 * whose duplicate check now short-circuits — the redelivery could never repair
 * the attachment anyway, and every retry would be a no-op with a 500. A failed
 * attachment is logged and omitted; a retry-later state is explicitly out of
 * scope for v1.
 *
 * Deliberately sequential: a serverless function has a small memory ceiling and
 * an email can carry many multi-megabyte files (Architecture PRD). One at a time
 * bounds peak memory to the largest single attachment.
 *
 * `size_bytes` is taken from the bytes actually downloaded, not the reported
 * metadata — the metadata number can describe the transfer-encoded size, and a
 * row that disagrees with the object in the bucket is worse than a slow read.
 */
export async function storeInboundAttachments(
	db: Database,
	input: {
		emailId: string;
		resendEmailId: string;
		attachments: InboundAttachmentMetadata[];
	},
	deps: StoreInboundAttachmentsDeps
): Promise<StoreInboundAttachmentsResult> {
	const stored: Attachment[] = [];
	const failed: string[] = [];

	for (const attachment of input.attachments) {
		const key = attachmentObjectKey(input.resendEmailId, attachment);
		try {
			const { bytes, contentType } = await deps.download(input.resendEmailId, attachment.id);
			const body = Buffer.from(bytes);
			const resolvedContentType = attachment.content_type || contentType || FALLBACK_CONTENT_TYPE;

			await deps.upload(key, body, resolvedContentType);

			stored.push(
				await insertAttachment(db, {
					emailId: input.emailId,
					filename: attachmentFilename(attachment),
					contentType: resolvedContentType,
					sizeBytes: body.byteLength,
					r2ObjectKey: key
				})
			);
		} catch (err) {
			// Ids only, no filename: an attachment name is user content and this
			// line goes to the platform's function logs on every delivery.
			failed.push(attachment.id);
			console.error(
				`inbound attachment failed (email ${input.resendEmailId}, attachment ${attachment.id}, key ${key}):`,
				err
			);
		}
	}

	return { stored, failed };
}
