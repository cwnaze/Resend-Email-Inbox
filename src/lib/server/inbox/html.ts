// The read-path pass that blocks remote images in a stored HTML body (US-G02,
// tasks/prd-feature-thread-view.md FR-3).
//
// Server-only (it pulls in DOMPurify/jsdom) and deliberately *not* part of the
// write path: `emails.body_html` keeps the sender's image URLs, because the
// "Load images" affordance has to be able to put them back. Blocking is a
// rendering decision, made per view, per message — which is exactly what FR-3
// asks for ("opt-in per message, not globally toggled once for the whole app").
import DOMPurify from 'isomorphic-dompurify';
import { SANITIZE_OPTIONS } from '../inbound/sanitize';
import { BLOCKED_IMAGE_ATTR } from '../../inbox/srcdoc';

/**
 * Elements whose `src` reaches the network but which have no "show it anyway"
 * affordance in this view. Their `src` is dropped outright rather than parked on
 * `data-dt-blocked-src`: an email that needs an autoplaying remote video to be
 * readable does not exist, and offering to load one would be a second, wider
 * opt-in than the story asks for.
 */
const UNRESTORABLE_MEDIA = new Set(['VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'INPUT', 'EMBED']);

/** Attributes on those elements that would each cause their own fetch. */
const UNRESTORABLE_MEDIA_ATTRS = ['src', 'poster'];

export interface PreparedEmailHtml {
	/** Sanitized markup with every remote image `src` moved aside. */
	html: string;
	/** How many images were blocked — 0 means the toggle isn't worth showing. */
	blockedImageCount: number;
}

/**
 * A `src` that costs the reader nothing to load.
 *
 * `data:` is bytes already in the body. `cid:` is an inline-attachment reference
 * that this app does not resolve, so it will never load either way, but it also
 * never reaches a third party — treating it as remote would show a "Load images"
 * button that cannot do anything.
 */
function isLocalSource(src: string): boolean {
	const value = src.trim().toLowerCase();
	return value.startsWith('data:') || value.startsWith('cid:');
}

/**
 * Sanitizes a stored HTML body and moves every remote image `src` aside.
 *
 * Re-sanitizing is intentional even though the write path already did
 * (`storeInboundEmail` → `sanitizeEmailHtml`): rows written before that existed,
 * or by any future non-inbound path, must not be rendered under weaker rules
 * than today's, and the same `SANITIZE_OPTIONS` is used so the two can't drift.
 *
 * Returns `null` when there is no HTML worth rendering, so the caller falls
 * through to the plain-text branch rather than mounting an empty iframe.
 */
export function prepareEmailHtml(html: string | null | undefined): PreparedEmailHtml | null {
	if (typeof html !== 'string' || html.trim() === '') return null;

	let blockedImageCount = 0;

	// The hook is added and removed around this one `sanitize` call rather than
	// registered once at module scope: it closes over `blockedImageCount`, so a
	// second concurrent call must not be able to see it. `sanitize` is
	// synchronous and Node runs one turn at a time, which makes
	// add → sanitize → remove atomic — but only as long as nothing async is
	// introduced between those three lines. Don't.
	const hook = (node: Element) => {
		if (typeof node.getAttribute !== 'function') return;

		if (UNRESTORABLE_MEDIA.has(node.tagName)) {
			for (const attribute of UNRESTORABLE_MEDIA_ATTRS) node.removeAttribute(attribute);
			return;
		}

		if (node.tagName !== 'IMG') return;

		const src = node.getAttribute('src');
		if (src === null || isLocalSource(src)) return;

		node.removeAttribute('src');
		node.setAttribute(BLOCKED_IMAGE_ATTR, src);
		blockedImageCount++;
	};

	DOMPurify.addHook('afterSanitizeAttributes', hook);
	let clean: string;
	try {
		clean = DOMPurify.sanitize(html, SANITIZE_OPTIONS);
	} finally {
		DOMPurify.removeHook('afterSanitizeAttributes');
	}

	if (clean.trim() === '') return null;
	return { html: clean, blockedImageCount };
}
