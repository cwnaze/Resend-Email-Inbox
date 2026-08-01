// The rules for files attached to a composed message (US-H05).
//
// Pure like `addresses.ts` and `reply.ts` — no env, no db, no DOM — and for the
// same reason `addresses.ts` is: **the browser and the server both enforce these
// rules, and two copies of them would drift silently.** The compose screen gates
// its Send button on the size limit here, the upload endpoint refuses an
// oversized file with it, and the `send` action re-checks the total against the
// sizes R2 actually reports. One definition, three callers.
//
// Imported by relative path from `server/outbound/uploads.ts` (bare `tsx` has no
// Vite alias resolution — see CLAUDE.md).

/**
 * The most one message may carry, summed across every file on it — the ones a
 * forward brought along (US-H04) and the ones the owner picked (US-H05) alike.
 *
 * Resend's own ceiling is 40 MB per message; this sits under it because the
 * binding constraint is not the provider's limit but the memory of the
 * serverless function that has to hold every file at once on its way to the send
 * call.
 *
 * Base 1000, not 1024, because `formatFileSize` renders in base 1000 and this
 * number is shown to the owner when a send is refused: 25 MiB reads back as
 * "26.2 MB", which is not a limit anybody set.
 */
export const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1000 * 1000;

/** Anything with a byte size — a picked `File`, a stored row, an R2 HEAD. */
export type SizedAttachment = { sizeBytes: number };

export function attachmentTotalBytes(attachments: SizedAttachment[]): number {
	return attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
}

export function isAttachmentTotalTooLarge(attachments: SizedAttachment[]): boolean {
	return attachmentTotalBytes(attachments) > MAX_ATTACHMENT_TOTAL_BYTES;
}

/**
 * A filesystem-safe display filename for a file the *client* named.
 *
 * The same reduction `inbound/attachments.ts` applies to a sender-supplied name,
 * for the same reason and one more: this string is stored in a text column, is
 * later offered to a browser as a download name, and — unlike the inbound case —
 * arrives in a form field, so it is not even bounded by what a file picker can
 * produce. Reduced to one path segment here rather than at render time.
 *
 * A name that reduces to nothing becomes `attachment` rather than an empty
 * string: a file with no visible name in the list reads as a broken row.
 */
export function composeAttachmentFilename(raw: string): string {
	// eslint-disable-next-line no-control-regex -- stripping exactly these bytes is the point
	const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
	const base = stripped.split(/[/\\]/).pop()?.trim() ?? '';
	if (base === '' || base === '.' || base === '..') return 'attachment';
	return base.slice(0, 255);
}

/**
 * The key prefix every browser-uploaded attachment lands under, before the send
 * that claims it.
 *
 * The prefix is load-bearing, not decoration. The browser uploads straight to R2
 * (a presigned PUT) and then submits the *key* with the form, so the key is
 * request input — and the action turns a key into bytes it attaches to outgoing
 * mail. Confining the accepted shape to keys this app minted for a pending
 * upload is what stops a hand-written POST from naming, say, an `inbound/…`
 * object and mailing it out. See `server/outbound/uploads.ts`.
 */
export const PENDING_ATTACHMENT_PREFIX = 'outbound/pending/';

const PENDING_KEY_PATTERN =
	/^outbound\/pending\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z0-9._-]*$/;

/** True for a key this app minted in `POST /compose/uploads`, and nothing else. */
export function isPendingAttachmentKey(key: string): boolean {
	return PENDING_KEY_PATTERN.test(key);
}

/** One picked file, as it travels from the browser back to the send action. */
export type PendingAttachment = {
	/** The R2 object the browser already uploaded to. */
	key: string;
	filename: string;
	/**
	 * **Display bookkeeping only, and never trusted.** It exists so a refused send
	 * can re-render the list with sizes next to the filenames instead of "0 B",
	 * and so the browser's running total survives the round trip. The size the
	 * *limit* is enforced against is the one R2 reports for the object
	 * (`server/outbound/uploads.ts`), which is why a client understating this
	 * number buys nothing.
	 */
	sizeBytes: number;
};

/**
 * One row of the compose screen's attachment list, while the screen is open.
 *
 * A superset of `PendingAttachment` (what actually submits) because the list has
 * to show a file that is still uploading or whose upload failed — neither of
 * which has a key yet, and both of which the owner needs to see rather than
 * discover missing from a sent message. It lives here rather than in the
 * component so the page can hold the list and gate Send on it.
 */
export type AttachmentItem = {
	/** List key. Two picked files can share a name, so it cannot be the name. */
	id: string;
	filename: string;
	sizeBytes: number;
	/** The R2 object, once it exists. Only a keyed item is submitted. */
	key: string | null;
	status: 'uploading' | 'ready' | 'failed';
};

/**
 * Reads the hidden `attachments` field back out of a submitted form.
 *
 * Everything here is untrusted: the field is a JSON string in a form the owner's
 * browser wrote but anything could have written. The key is checked against
 * `isPendingAttachmentKey`, the filename is sanitized, and `sizeBytes` is
 * clamped to a finite non-negative number — but **nothing the send does depends
 * on that size**, and the content type is not read from here at all. The action
 * asks R2 what each object actually is, so a client cannot understate a 40 MB
 * file into the limit; the parsed size is carried only so a refused send can
 * re-render the list it came from.
 *
 * Malformed input yields an empty list rather than throwing. A send whose
 * attachment field is garbage should not 500; it should behave like a send with
 * no attachments, and the size check that follows still runs.
 */
export function parsePendingAttachments(raw: string): PendingAttachment[] {
	if (raw.trim() === '') return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const seen = new Set<string>();
	const attachments: PendingAttachment[] = [];
	for (const entry of parsed) {
		if (typeof entry !== 'object' || entry === null) continue;
		const { key, filename, sizeBytes } = entry as {
			key?: unknown;
			filename?: unknown;
			sizeBytes?: unknown;
		};
		if (typeof key !== 'string' || !isPendingAttachmentKey(key)) continue;
		// One key twice would attach one file twice and, worse, insert two
		// `attachments` rows pointing at a single object — deleting either would
		// empty the other, the aliasing bug `outbound/attachments.ts` avoids by
		// copying.
		if (seen.has(key)) continue;
		seen.add(key);
		attachments.push({
			key,
			filename: composeAttachmentFilename(typeof filename === 'string' ? filename : ''),
			sizeBytes:
				typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > 0
					? Math.floor(sizeBytes)
					: 0
		});
	}
	return attachments;
}
