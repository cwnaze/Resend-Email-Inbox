// The sandboxed HTML email document (US-G02, tasks/prd-feature-thread-view.md
// FR-2/FR-3).
//
// Pure by design — no env, no db, no DOM, no dependencies — so the server load,
// the Svelte component and the standalone `tsx` verification script all build
// the *same* document, same rationale as `format.ts`.
//
// The blocking half of this feature lives on the server
// (`$lib/server/inbox/html.ts`, which needs DOMPurify): by the time HTML reaches
// this module every remote image `src` has already been moved aside onto
// `data-dt-blocked-src`. This module only decides how that HTML is wrapped, and
// whether the moved-aside attributes are put back.

/**
 * Where a blocked remote image's URL is parked.
 *
 * It is a `data-*` attribute on purpose: the sanitizer runs with
 * `ALLOW_DATA_ATTR: false`, so a sender cannot smuggle this attribute in
 * themselves and have it survive to be restored — the only values here are the
 * ones the blocking pass moved.
 */
export const BLOCKED_IMAGE_ATTR = 'data-dt-blocked-src';

/**
 * Puts blocked image URLs back on `src` for the "Load images" state.
 *
 * A plain regex is safe here *because the input is not arbitrary markup*: the
 * attribute and its value were written by DOMPurify's own serializer during the
 * blocking pass, so the value is HTML-escaped and cannot contain a `"`. Never
 * point this at markup that hasn't been through that pass.
 */
export function restoreBlockedImages(html: string): string {
	return html.replace(new RegExp(`\\s${BLOCKED_IMAGE_ATTR}="([^"]*)"`, 'g'), ' src="$1"');
}

/**
 * Styling for the iframe document.
 *
 * Deliberately light-on-white regardless of the app's theme: email HTML brings
 * its own colours and overwhelmingly assumes a light background, so forcing a
 * dark canvas under it produces unreadable dark-on-dark text. `color-scheme:
 * light` stops the browser from re-tinting form controls and scrollbars.
 *
 * The blocked-image placeholder is an attribute selector rather than a class, so
 * that restoring `src` removes the placeholder styling by construction — there
 * is no second thing to remember to strip.
 */
const DOCUMENT_STYLES = `
:root { color-scheme: light; }
html, body { margin: 0; padding: 0; background: #ffffff; color: #16181d; }
body {
	font: 400 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
	overflow-wrap: break-word;
	word-break: break-word;
}
img, video { max-width: 100%; height: auto; }
img[${BLOCKED_IMAGE_ATTR}] {
	min-width: 3rem;
	min-height: 1.5rem;
	border: 1px dashed #9aa0a6;
	background: #f1f2f4;
}
table { max-width: 100%; border-collapse: collapse; }
a { color: #1b4fd8; }
blockquote {
	margin: 0 0 0 0.25rem;
	padding-left: 0.75rem;
	border-left: 2px solid #d7d9dd;
	color: #4c525c;
}
pre { white-space: pre-wrap; }
`;

/**
 * Wraps a prepared email body in the document that gets handed to
 * `<iframe srcdoc>`.
 *
 * The iframe itself is sandboxed (`sandbox="allow-same-origin"`, never
 * `allow-scripts`), which is the real containment. The CSP `<meta>` here is
 * defence in depth for the *network* half: `default-src 'none'` means nothing in
 * a stored body can fetch anything, and `img-src` is the one thing the "Load
 * images" toggle opens up. So the toggle is enforced twice — the attribute swap
 * and the policy — rather than by the attribute swap alone.
 */
export function buildEmailSrcdoc(html: string, options: { showImages?: boolean } = {}): string {
	const showImages = options.showImages === true;
	const body = showImages ? restoreBlockedImages(html) : html;
	// `data:` stays allowed while images are blocked: a data URI is bytes we
	// already have, so it reveals nothing to a third party. Remote schemes are
	// what tracking pixels need.
	const imgSrc = showImages ? 'img-src data: https: http:' : 'img-src data:';
	const csp = `default-src 'none'; ${imgSrc}; style-src 'unsafe-inline'`;

	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		`<meta http-equiv="Content-Security-Policy" content="${csp}">`,
		`<style>${DOCUMENT_STYLES}</style></head><body>`,
		body,
		'</body></html>'
	].join('');
}
