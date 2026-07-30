// Attachment-download header construction (US-G03,
// tasks/prd-feature-thread-view.md).
//
// Pure — no env, no db, no DOM, no dependencies — so the download endpoint and
// `db/verify-inbox-list.mts` share one implementation. It lives under
// `server/inbox/` beside `html.ts` because nothing in the browser has any use
// for it, and like that module it must be importable by **relative** path from a
// bare `tsx` script (no Vite alias resolution), so nothing here imports `$lib/…`.

/**
 * A filename safe to place inside a quoted `Content-Disposition` parameter.
 *
 * `attachments.filename` is sender-controlled. `attachmentFilename` in
 * `inbound/attachments.ts` already reduced it to a single path segment with no
 * control characters *at write time*, but this is a header value being built
 * from a database column, and a header is exactly where a stray `"`, `\`, CR or
 * LF stops being cosmetic: a raw newline is response splitting. So the escaping
 * happens here, at the point of use, rather than being assumed from the write
 * path — rows written before that sanitizer existed would otherwise be trusted.
 */
function quotedFilename(filename: string): string {
	return (
		filename
			// Escape backslash and `"`— either would end the quoted string — then replace
			// anything outside printable US-ASCII, which covers every control
			// character, so CR/LF response splitting falls to the same pass. A
			// quoted-string parameter is US-ASCII only anyway; non-ASCII names travel
			// in the `filename*` form below, and this is what a client that ignores
			// that form sees.
			.replace(/[\\"]/g, '_')
			.replace(/[^\x20-\x7e]/g, '_')
			.trim()
			.slice(0, 200) || 'attachment'
	);
}

/**
 * The `Content-Disposition` header value for downloading `filename`.
 *
 * Always `attachment`, never `inline`, for every content type. The bytes and the
 * `Content-Type` next to them both come from whoever sent the email, so `inline`
 * would let a sender choose to have a document rendered by the browser; forcing a
 * download means the reader opens it deliberately, in whatever application they
 * choose. (The object is served from R2's own origin, so an `inline` HTML
 * attachment could not script this app either way — but "the story asks for a
 * download" and "don't render sender-supplied documents by default" point the
 * same direction.)
 *
 * Both parameter forms are emitted, per RFC 6266: the quoted ASCII `filename`
 * for any client that doesn't implement RFC 5987, and the percent-encoded
 * `filename*` — which every current browser prefers — so a name with accents or
 * CJK characters survives instead of arriving as underscores.
 */
export function attachmentContentDisposition(filename: string): string {
	const ascii = quotedFilename(filename);
	// `encodeURIComponent` alone is NOT enough here. It leaves `!'()*` unescaped,
	// and of those only `!` is an RFC 8187 `attr-char` — `'` in particular is the
	// ext-value's own delimiter, so a filename like `report'(final).pdf` would emit
	// `filename*=UTF-8''report'(final).pdf` and a strict parser can split it at the
	// wrong quote. Percent-encode the four it misses so the ext-value contains only
	// attr-chars and `%`.
	const encoded =
		encodeURIComponent(filename.replace(/[\r\n]/g, '')).replace(
			/['()*]/g,
			(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
		) || 'attachment';
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The `Content-Type` to answer a download with.
 *
 * `attachments.content_type` is also sender-controlled, and a value carrying a
 * CR/LF or a `;`-appended parameter would be injected straight into a signed
 * response header. Anything that isn't a plain `type/subtype` token pair
 * collapses to the generic binary type — which is a harmless answer for a
 * response that is already `Content-Disposition: attachment`.
 */
export function downloadContentType(contentType: string): string {
	const trimmed = contentType.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(trimmed)
		? trimmed
		: 'application/octet-stream';
}
