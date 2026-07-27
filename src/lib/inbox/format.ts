// Presentation helpers for the inbox list (US-F01).
//
// Pure by design — no env, no db, no DOM — so both the server load and the
// Svelte components can import them and a standalone `tsx` script can assert
// against them, same rationale as `server/inbound/parse.ts`.

const SNIPPET_MAX_LENGTH = 140;

/**
 * Strips markup from a stored HTML body well enough for a one-line preview.
 *
 * This is *not* a sanitizer and must never be used to produce something that
 * gets rendered as markup — inbound HTML is already sanitized on the write path
 * (`server/inbound/sanitize.ts`) and the snippet this produces is inserted as
 * text. It only needs to stop tag soup from showing up in the preview line.
 */
function stripHtml(html: string): string {
	return (
		html
			// Drop whole elements whose *content* is not prose. `sanitizeEmailHtml`
			// already forbids these, but a body stored before that ran (or an
			// outbound body composed elsewhere) would otherwise leak CSS/JS text
			// into the preview.
			.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
			.replace(/<br\s*\/?>/gi, ' ')
			.replace(/<\/(p|div|tr|li|h[1-6])>/gi, ' ')
			.replace(/<[^>]*>/g, '')
			// A preview is text, so the entities that matter are the ones that
			// would otherwise show up literally as `&amp;` to the reader.
			.replace(/&nbsp;/gi, ' ')
			.replace(/&amp;/gi, '&')
			.replace(/&lt;/gi, '<')
			.replace(/&gt;/gi, '>')
			.replace(/&quot;/gi, '"')
			.replace(/&#39;/gi, "'")
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
