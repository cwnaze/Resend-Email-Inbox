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
	/**
	 * Whether this HTML shows the reader anything: real text, or an image that is
	 * demonstrably not a tracking pixel.
	 *
	 * Decided **here, from the DOM**, and that is the whole point. Every previous
	 * attempt to answer this by pattern-matching the finished markup was defeated
	 * by the sender: a regex over an `<img …>` tag also reads the URL parked on
	 * `data-dt-blocked-src` (so `hero.png?height=2` looked like a 2px image), and a
	 * de-tagging regex stops at the first `>` (so a `>` inside a query string leaked
	 * `2">` and counted as "visible text"). Attributes are attributes here, and
	 * `textContent` is text.
	 */
	hasVisibleContent: boolean;
}

/**
 * `width`/`height` at or below this means a spacer or a tracking pixel, not
 * something anyone is meant to see.
 */
const TRACKING_PIXEL_MAX_PX = 3;

/**
 * A declared dimension, split by unit; both `null` when it isn't a number.
 *
 * Tolerant of the shapes hand-written email HTML actually contains — `600px` and
 * `600.5` are invalid in a `width` attribute and browsers ignore the unit, but
 * senders write them, and reading them as "no size declared" would make a real
 * hero image lose to a "view in browser" text stub.
 */
function declaredSize(
	image: Element,
	name: 'width' | 'height'
): { px: number | null; pct: number | null } {
	const raw = image.getAttribute(name)?.trim() ?? '';
	const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(raw);
	if (percent) return { px: null, pct: Number(percent[1]) };
	const pixels = /^(\d+(?:\.\d+)?)\s*(?:px)?$/i.exec(raw);
	return { px: pixels ? Number(pixels[1]) : null, pct: null };
}

/**
 * Whether an image is *positively* something to look at.
 *
 * "Positively" is the correction for a real bug: treating an unknown size as
 * "could be real" meant a dimensionless tracking pixel — the common kind, sized
 * by the CSS this app strips — counted as content and discarded the readable
 * `text/plain` part of the message. So an image now has to declare a size above
 * pixel range (in px, or as a percentage, which is how responsive hero images are
 * sized and which no tracker uses), and must not declare a pixel-range size on
 * either axis (a 600×1 rule is a spacer).
 */
function isDefiniteImage(image: Element): boolean {
	const width = declaredSize(image, 'width');
	const height = declaredSize(image, 'height');

	const tiny = [width.px, height.px].some((px) => px !== null && px <= TRACKING_PIXEL_MAX_PX);
	if (tiny) return false;

	return [width.px, height.px, width.pct, height.pct].some(
		(value) => value !== null && value > TRACKING_PIXEL_MAX_PX
	);
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
		// `template` is forbidden on *this* path only. Its children live in a
		// separate `content` fragment that the walk below cannot reach, so a remote
		// image in there would be neither parked nor counted. Forbidding it on the
		// shared write path instead would delete the text inside it from the only
		// copy of the message — see the note in `inbound/sanitize.ts`.
		FORBID_TAGS: [...SANITIZE_OPTIONS.FORBID_TAGS, 'template'],
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
	let hasDefiniteImage = false;
	for (const image of container.querySelectorAll('img')) {
		const src = image.getAttribute('src');

		// An image with no `src` at all — including one whose `javascript:` src
		// DOMPurify just removed — can never render, so it must not make the body
		// look like it has content. Checking this *before* the size test is the fix
		// for a body of `<img src="javascript:…" width="600">` mounting an empty
		// frame while a readable text part was thrown away.
		if (src !== null && isDefiniteImage(image)) hasDefiniteImage = true;

		// A `src` DOMPurify rejected is already gone by now, which is why parking one
		// can never reintroduce a scheme the sanitizer refused.
		if (src === null || isLocalSource(src)) continue;

		image.removeAttribute('src');
		image.setAttribute(BLOCKED_IMAGE_ATTR, src);
		blockedImageCount++;
	}

	const clean = container.innerHTML;
	if (clean.trim() === '') return null;
	return {
		html: clean,
		blockedImageCount,
		// `textContent` is the text that will actually render — no attribute values,
		// no tag fragments, nothing a sender can smuggle past a regex.
		hasVisibleContent: (container.textContent ?? '').trim() !== '' || hasDefiniteImage
	};
}
