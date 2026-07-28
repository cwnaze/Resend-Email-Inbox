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
 * Elements whose `src`/`poster` reaches the network but which have no "show it
 * anyway" affordance in this view. Their attributes are dropped outright rather
 * than parked on `data-dt-blocked-src`: an email that needs an autoplaying
 * remote video to be readable does not exist, and offering to load one would be
 * a second, wider opt-in than the story asks for.
 *
 * Only tags that actually survive sanitization belong here — `input`/`embed`
 * are in `FORBIDDEN_TAGS`, so listing them would be a branch that can never run
 * and would imply this pass is what makes them safe when `FORBID_TAGS` is.
 */
const UNRESTORABLE_MEDIA = new Set(['VIDEO', 'AUDIO', 'SOURCE', 'TRACK']);

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
 * The rewrite walks the sanitized **DOM fragment** rather than registering a
 * DOMPurify `afterSanitizeAttributes` hook. Hooks live on the module-wide
 * DOMPurify singleton, so the hook version was only correct while nothing
 * `await`ed between adding and removing it, and its `removeHook` popped
 * whichever hook happened to be last rather than this one — a future second hook
 * anywhere in the process could have left this closure installed on the *write*
 * path, quietly writing `data-dt-blocked-src` into stored bodies. Walking the
 * fragment has no global state to get wrong. (Verified byte-identical to the
 * string mode across the adversarial fixtures in `verify-inbox-list.mts`.)
 *
 * Returns `null` when there is no HTML worth rendering, so the caller falls
 * through to the plain-text branch rather than mounting an empty iframe.
 */
export function prepareEmailHtml(html: string | null | undefined): PreparedEmailHtml | null {
	if (typeof html !== 'string' || html.trim() === '') return null;

	const fragment = DOMPurify.sanitize(html, {
		...SANITIZE_OPTIONS,
		RETURN_DOM_FRAGMENT: true
	}) as unknown as DocumentFragment;

	// A fragment can't be serialized directly; an unattached container whose
	// `innerHTML` we read is the same serialization DOMPurify's string mode does.
	const container = fragment.ownerDocument.createElement('div');
	container.appendChild(fragment);

	for (const element of container.querySelectorAll('*')) {
		if (UNRESTORABLE_MEDIA.has(element.tagName)) {
			for (const attribute of UNRESTORABLE_MEDIA_ATTRS) element.removeAttribute(attribute);
		}
	}

	let blockedImageCount = 0;
	for (const image of container.querySelectorAll('img')) {
		const src = image.getAttribute('src');
		// A `src` DOMPurify rejected (`javascript:` and friends) is already gone by
		// now, which is why parking one can never reintroduce a scheme the
		// sanitizer refused.
		if (src === null || isLocalSource(src)) continue;

		image.removeAttribute('src');
		image.setAttribute(BLOCKED_IMAGE_ATTR, src);
		blockedImageCount++;
	}

	const clean = container.innerHTML;
	if (clean.trim() === '') return null;
	return { html: clean, blockedImageCount };
}
