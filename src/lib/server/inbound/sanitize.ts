// HTML sanitization for inbound email bodies (US-E03, FR-3 of
// tasks/prd-feature-inbound-processing.md).
//
// Pure by design (no env, no db, no network), same as `parse.ts`, so the
// standalone `verify-inbound-parse.mts` script can exercise it against
// fixtures.
//
// This is the *only* place inbound HTML is sanitized, and it happens on the
// **write** path: what lands in `emails.body_html` is already safe, so no
// renderer downstream has to remember to re-sanitize (and none of them can
// forget to). Never persist a raw `html` value from Resend.
import DOMPurify from 'isomorphic-dompurify';

/**
 * Tags that would make the reader's browser reach out to a third party (or run
 * code) the moment a stored email is rendered. DOMPurify's defaults already
 * drop `script`/`object`/`embed` and every `on*` handler; these are listed
 * explicitly because a *default* is a thing that can change under us, and
 * because a mail client leaking a read receipt via `<iframe>`/`<link>` is the
 * exact threat this story is about.
 */
const FORBIDDEN_TAGS = [
	'script',
	'iframe',
	'frame',
	'frameset',
	'object',
	'embed',
	'link',
	'base',
	'meta',
	'form',
	'input',
	'button',
	'textarea',
	'select',
	'option',
	'style',
	'svg',
	'math',
	// `template` holds its children in a separate `content` DocumentFragment that
	// `querySelectorAll` does not descend into, so a remote `<img>` parked in there
	// is invisible to US-G02's image-blocking walk (its count would be wrong, and
	// the URL would survive into the rendered document). Nothing in an email needs
	// a template — it exists to be cloned by script, and script is forbidden — so
	// dropping it outright is simpler and safer than teaching every future consumer
	// to recurse into it.
	'template'
];

/**
 * `srcset`/`background`/`ping` are remote-loading attributes DOMPurify allows
 * by default; `style` is forbidden because `url(...)` inside it is another
 * remote fetch. `formaction` is a submit vector. Event handlers are covered by
 * DOMPurify itself (it strips every `on*` attribute unconditionally).
 */
const FORBIDDEN_ATTRS = ['srcset', 'background', 'ping', 'style', 'formaction', 'action'];

/**
 * The single sanitizer configuration.
 *
 * Exported so the read-path pass that blocks remote images
 * (`$lib/server/inbox/html.ts`, US-G02) re-sanitizes with *these* rules rather
 * than a second, drifting copy of them — a body stored before this module
 * existed would otherwise be rendered under weaker rules than a body stored
 * after it.
 */
export const SANITIZE_OPTIONS = {
	FORBID_TAGS: FORBIDDEN_TAGS,
	FORBID_ATTR: FORBIDDEN_ATTRS,
	// `data-*` attributes are inert on their own but are how a lot of
	// tracking/templating markup smuggles state through; nothing in this app
	// reads them, so drop them. (URI *schemes* are handled by DOMPurify's own
	// allow-list, which already excludes `javascript:`.)
	ALLOW_DATA_ATTR: false,
	// Keep the fragment a fragment — no <html>/<body> wrapper injected into
	// what we store.
	WHOLE_DOCUMENT: false
} as const;

/**
 * Sanitizes an inbound HTML body.
 *
 * Returns `null` for a null/undefined/blank input so the column stays NULL
 * rather than holding an empty string, and so a body that was *entirely*
 * malicious markup (`<script>…</script>` and nothing else) reads as "no HTML
 * body" instead of "empty body we chose to keep".
 */
export function sanitizeEmailHtml(html: string | null | undefined): string | null {
	if (typeof html !== 'string' || html.trim() === '') return null;

	const clean = DOMPurify.sanitize(html, SANITIZE_OPTIONS);

	return clean.trim() === '' ? null : clean;
}
