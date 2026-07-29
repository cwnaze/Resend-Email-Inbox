// Presentation helpers for the inbox list (US-F01).
//
// Pure by design — no env, no db, no DOM — so both the server load and the
// Svelte components can import them and a standalone `tsx` script can assert
// against them, same rationale as `server/inbound/parse.ts`.

const SNIPPET_MAX_LENGTH = 140;

/**
 * Decodes the handful of entities that would otherwise show up literally
 * ("&amp;") to a reader of de-tagged HTML.
 *
 * `&amp;` is decoded **last** on purpose: doing it first turns `&amp;lt;` — the
 * escaping of a literal "&lt;" — into `<`, i.e. it double-decodes.
 */
function decodeBasicEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, ' ')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&amp;/gi, '&');
}

/**
 * Matches one tag, well enough to de-tag into text. Not a parser, not a sanitizer.
 *
 * Deliberately the naive form. A version that skipped over quoted attribute
 * values — so that a sender-controlled `>` inside an attribute
 * (`<img src="x?d=1>2">`) could not end the tag early and leave `2">` behind as
 * apparent text — turned out to backtrack catastrophically: on a body containing a
 * run of bare `<` characters it went from 6ms to **15 seconds** at 4000 chars, and
 * these helpers run for every row of the inbox list, so one such body would block
 * the event loop and take the whole inbox down. The leak it fixed is now purely
 * cosmetic (a stray `2">` in a snippet), because the decision that used to depend
 * on it — whether a message's HTML has anything visible — is made in the DOM in
 * `server/inbox/html.ts`. A denial of service is not worth a tidier snippet.
 *
 * This form is not unconditionally cheap either: it is quadratic in the length of
 * a run of bare `<` characters (~11s for 200KB of them), because each one starts a
 * scan to the end of the string. That is the behaviour this app has shipped since
 * US-F01 and it is not reachable through the write path — DOMPurify escapes stray
 * `<` to `&lt;` — so it is only a consideration for a body stored before the
 * sanitizer existed. If that ever needs a bound, cap the *input length* here rather
 * than making the pattern cleverer; the clever pattern is what caused the outage
 * risk above.
 */
const HTML_TAG = /<[^>]*>/g;

/** Removes tags whose *content* is not prose, along with the content itself. */
function dropNonProseElements(html: string): string {
	// `sanitizeEmailHtml` already forbids these, but a body stored before that
	// ran (or an outbound body composed elsewhere) would otherwise leak CSS/JS
	// source text into the reading view.
	return html.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

/**
 * Strips markup from a stored HTML body well enough for a one-line preview.
 *
 * This is *not* a sanitizer and must never be used to produce something that
 * gets rendered as markup — inbound HTML is already sanitized on the write path
 * (`server/inbound/sanitize.ts`) and the snippet this produces is inserted as
 * text. It only needs to stop tag soup from showing up in the preview line.
 */
function stripHtml(html: string): string {
	return decodeBasicEntities(
		dropNonProseElements(html)
			.replace(/<br\s*\/?>/gi, ' ')
			.replace(/<\/(p|div|tr|li|h[1-6])>/gi, ' ')
			.replace(HTML_TAG, '')
	);
}

/**
 * A short single-line preview of an email body.
 *
 * Prefers `body_text` (stored verbatim, never markup) and falls back to
 * de-tagged `body_html` for an HTML-only email — which is most of them.
 * Returns `''` when there is nothing to preview, so the caller renders no
 * snippet line rather than an ellipsis with no content behind it.
 */
export function bodySnippet(
	bodyText: string | null,
	bodyHtml: string | null,
	maxLength = SNIPPET_MAX_LENGTH
): string {
	const source = bodyText?.trim() ? bodyText : bodyHtml ? stripHtml(bodyHtml) : '';
	const collapsed = source.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= maxLength) return collapsed;
	// Cut on a word boundary when there is one reasonably close to the limit,
	// so the preview doesn't end mid-word.
	const cut = collapsed.slice(0, maxLength);
	const lastSpace = cut.lastIndexOf(' ');
	return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The sender as one display string: name when known, else the bare address. */
export function senderLabel(fromName: string | null, fromEmail: string): string {
	const name = fromName?.trim();
	return name ? name : fromEmail;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * A compact relative timestamp for a list row ("now", "5m ago", "2h ago",
 * "3d ago", then an absolute date once it's older than a week).
 *
 * `now` is injectable so this is deterministic under test; the default makes
 * call sites read cleanly. A future timestamp (clock skew between the sender's
 * `Date:` header and this machine) renders as "now" rather than a negative
 * duration.
 */
export function relativeTime(date: Date, now: Date = new Date()): string {
	const elapsed = now.getTime() - date.getTime();
	if (elapsed < MINUTE_MS) return 'now';
	if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
	if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
	if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`;
	const sameYear = date.getFullYear() === now.getFullYear();
	return date.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		...(sameYear ? {} : { year: 'numeric' })
	});
}

/**
 * De-tags an HTML body into readable plain text, preserving its line structure
 * (US-G01).
 *
 * Distinct from `bodySnippet`'s use of the same de-tagging: a snippet collapses
 * every run of whitespace into one line, while a body needs its paragraph and
 * line breaks to stay readable. Like `bodySnippet`, this is **not** a sanitizer
 * and its output must only ever be inserted as text.
 *
 * This is the *interim* rendering for an HTML-only message. US-G02 replaces it
 * with a sandboxed `<iframe srcdoc>` and per-message remote-image opt-in
 * (prd-feature-thread-view FR-2/FR-3); until that exists, showing a de-tagged
 * transcript is strictly better than either shipping raw markup to the browser
 * or showing the reader nothing at all.
 */
export function htmlToPlainText(html: string): string {
	const detagged = dropNonProseElements(html)
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article)\s*>/gi, '\n\n')
		.replace(HTML_TAG, '');

	return (
		decodeBasicEntities(detagged)
			// Horizontal whitespace collapses (HTML's own rule, and email HTML is
			// full of indentation); vertical whitespace is the structure worth
			// keeping, capped at one blank line so a table-based layout doesn't
			// open with twenty of them.
			.replace(/\r\n?/g, '\n')
			.replace(/[^\S\n]+/g, ' ')
			.replace(/ *\n */g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim()
	);
}

/**
 * A message body as plain text, preferring `body_text` (stored verbatim, never
 * markup) and falling back to de-tagged `body_html`.
 *
 * Same precedence as `bodySnippet`, deliberately: a thread row's preview and the
 * message it opens should not be derived from different halves of the same row.
 */
export function bodyPlainText(bodyText: string | null, bodyHtml: string | null): string {
	if (bodyText?.trim()) return bodyText.replace(/\r\n?/g, '\n').trimEnd();
	return bodyHtml ? htmlToPlainText(bodyHtml) : '';
}

/**
 * A recipient list as one display string, or `''` when there are none.
 *
 * The column is a nullable JSON array (`cc_emails`/`bcc_emails`), and a row
 * written before a later story could hold `[]` or a blank entry, so both the
 * null and the all-empty cases have to collapse to "render no line" rather than
 * to a dangling "cc:" label.
 */
export function addressListLabel(addresses: string[] | null | undefined): string {
	if (!addresses) return '';
	return addresses
		.map((address) => address.trim())
		.filter((address) => address !== '')
		.join(', ');
}

/**
 * The full timestamp for a message header (US-G01) — unlike the list's
 * `relativeTime`, a thread being read is exactly where the reader wants the
 * actual date and time.
 *
 * Rendered in the viewer's locale-independent `en-US` form for the same reason
 * `relativeTime` does: the app has a single owner and a deterministic string is
 * what makes this assertable from a verification script.
 */
export function absoluteTime(date: Date): string {
	return date.toLocaleString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A human-readable byte count for an attachment's label (US-G03).
 *
 * Decimal units (1 KB = 1000 B), matching what a mail client and the sender's
 * own OS report, so the number next to a filename agrees with what the sender
 * saw. One decimal place from KB up, none for bytes — "1.5 KB" is useful,
 * "1.5 B" is not.
 *
 * `size_bytes` is `integer NOT NULL` and is written from the bytes actually
 * downloaded (see `inbound/attachments.ts`), so it is always a real count in
 * practice. It is still guarded here rather than trusted, because this runs in
 * the thread view: a negative, fractional or non-finite value should render an
 * honest "0 B" or a rounded size, never `NaN undefined` in a message header.
 */
export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

	let value = Math.round(bytes);
	let unitIndex = 0;
	// Stop at the last unit rather than running off the end of the array — a
	// petabyte attachment is impossible, but an out-of-range index would render
	// `undefined` and that is the one outcome worth making unreachable.
	while (value >= 1000 && unitIndex < FILE_SIZE_UNITS.length - 1) {
		value /= 1000;
		unitIndex += 1;
	}

	const unit = FILE_SIZE_UNITS[unitIndex];
	// Bytes are whole by definition; `toFixed(1)` on an exact 1000-multiple would
	// also read as "1.0 KB", so trim a trailing `.0`.
	const rendered = unitIndex === 0 ? String(value) : value.toFixed(1).replace(/\.0$/, '');
	return `${rendered} ${unit}`;
}
