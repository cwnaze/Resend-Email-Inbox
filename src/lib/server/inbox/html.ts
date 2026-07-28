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
	 * Whether this HTML contains text the reader will actually see.
	 *
	 * This is the **only** thing allowed to suppress a message's `text/plain` part,
	 * and that is a hard-won rule: for six review rounds the thread view decided
	 * "HTML or text?" from a size heuristic over the images, and every threshold was
	 * one attribute away from being bypassed (`width="4"`, then `width="17"`) — each
	 * bypass silently discarding a readable text body with no way to reach it. A
	 * heuristic cannot win that argument, so it no longer gets to: unless the HTML
	 * has real text, the text part is rendered too.
	 *
	 * Decided **here, from the DOM**, and that is the whole point. Every previous
	 * attempt to answer this by pattern-matching the finished markup was defeated
	 * by the sender: a regex over an `<img …>` tag also reads the URL parked on
	 * `data-dt-blocked-src` (so `hero.png?height=2` looked like a 2px image), and a
	 * de-tagging regex stops at the first `>` (so a `>` inside a query string leaked
	 * `2">` and counted as "visible text"). Attributes are attributes here, and
	 * `textContent` is text.
	 */
	hasVisibleText: boolean;
	/**
	 * Whether some image here could actually show the reader something — used only
	 * to decide whether a frame is worth mounting, never to suppress text.
	 *
	 * "Could" is the operative word, and it is deliberately weaker than "definitely
	 * is": an image that declares no size at all is ambiguous (a hero sized by the
	 * stripped `style` attribute looks identical to a CSS-sized tracker), and the
	 * frame is where the reader gets to decide. What it excludes is the cases where
	 * a frame can only ever be blank: an image that *declares* itself pixel-sized, an
	 * image inside a non-rendering subtree, and a `cid:` reference this app cannot
	 * resolve. Without those exclusions a body of one 1×1 tracker mounted a blank
	 * frame whose only button existed to fire the beacon.
	 */
	hasLoadableImage: boolean;
}

/**
 * `width`/`height` at or below this means a spacer or a tracking pixel, not
 * something anyone is meant to see.
 *
 * 16 rather than a literal 1: a 1×1 gif is the canonical tracker but 4×4 and 10×10
 * ones exist, and at 3 the test was bypassed by simply declaring `width="4"`. No
 * real email's entire visible content is a 16px image, so the false-positive risk
 * is negligible. It cannot be made airtight — a tracker can always declare
 * `width="600"` — which is exactly why this flag no longer decides whether the
 * reader keeps access to the `text/plain` part. Only `hasVisibleText` does that.
 */
const TRACKING_PIXEL_MAX_PX = 16;

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
 * Whether an image *declares* itself too small to be worth looking at.
 *
 * Only a declared size counts. An undeclared one is genuinely ambiguous — a hero
 * image sized by the `style` attribute the sanitizer strips is indistinguishable
 * from a CSS-sized tracker — and resolving that ambiguity by guessing is what
 * previously made real messages unreachable, so it stays ambiguous and the reader
 * decides in the frame.
 */
function declaresPixelSize(image: Element): boolean {
	const width = declaredSize(image, 'width');
	const height = declaredSize(image, 'height');
	return [width.px, height.px].some((px) => px !== null && px <= TRACKING_PIXEL_MAX_PX);
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
 * Elements the UA stylesheet gives `display: none`, so their contents render
 * nothing even though the sanitizer allows them through.
 *
 * `hidden` is the obvious one but not the only one: a `<dialog>` without `open`
 * and a `<datalist>` both survive `SANITIZE_OPTIONS` and both render nothing, and
 * counting their text as visible let `<dialog>Full invoice text</dialog>` suppress
 * a readable `text/plain` part in favour of a frame that draws nothing at all.
 * Add to this list rather than assuming `[hidden]` covers it.
 */
function isNonRendering(element: Element): boolean {
	if (element.hasAttribute('hidden')) return true;
	if (element.tagName === 'DATALIST') return true;
	// A dialog renders only when open (and even then as a modal, but its text is at
	// least reachable).
	return element.tagName === 'DIALOG' && !element.hasAttribute('open');
}

/** Whether the element sits inside a subtree that renders nothing. */
function isHidden(element: Element): boolean {
	for (let node: Element | null = element; node !== null; node = node.parentElement) {
		if (isNonRendering(node)) return true;
	}
	return false;
}

/**
 * Whether the container holds text that will actually be rendered.
 *
 * `textContent` alone counts text that renders nothing: `<div hidden>x</div>`
 * survives sanitization, the UA stylesheet hides it, and counting its "x" made a
 * body of one hidden token plus a tracking pixel beat a readable `text/plain` part
 * — leaving the reader a blank 24px frame.
 *
 * Walks rather than cloning-and-stripping: this runs per message on every thread
 * load, and a walk short-circuits on the first visible character instead of
 * copying the whole tree (a 220KB body is not unusual in email).
 *
 * `style="display:none"` cannot be caught here at all: the sanitizer drops `style`
 * on the write path, so by the time this runs the element is genuinely visible.
 * That limitation is real and documented rather than papered over.
 */
function hasVisibleText(node: Node): boolean {
	for (const child of node.childNodes) {
		if (child.nodeType === 3) {
			if ((child.nodeValue ?? '').trim() !== '') return true;
			continue;
		}
		if (child.nodeType !== 1) continue;
		// Skip subtrees the UA stylesheet hides — see `isNonRendering`.
		if (isNonRendering(child as Element)) continue;
		if (hasVisibleText(child)) return true;
	}
	return false;
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
	let hasLoadableImage = false;
	for (const image of container.querySelectorAll('img')) {
		const src = image.getAttribute('src');
		const hidden = isHidden(image);

		// An image with no `src` at all — including one whose `javascript:` src
		// DOMPurify just removed — can never render, so it must not make the body
		// look like it has something to show. Nor can one inside a non-rendering
		// subtree (a `<div hidden>` wrapping a 600×400 image mounted a frame that
		// drew nothing), nor an unresolvable `cid:` reference, nor one that declares
		// itself a tracking pixel.
		if (
			src !== null &&
			!hidden &&
			!src.trim().toLowerCase().startsWith('cid:') &&
			!declaresPixelSize(image)
		) {
			hasLoadableImage = true;
		}

		// A `src` DOMPurify rejected is already gone by now, which is why parking one
		// can never reintroduce a scheme the sanitizer refused.
		if (src === null || isLocalSource(src)) continue;

		image.removeAttribute('src');
		image.setAttribute(BLOCKED_IMAGE_ATTR, src);
		// Hidden images are still *blocked* — a `display:none` image is fetched by
		// plenty of browsers, so the parking matters — but they are not counted,
		// because the count becomes a claim to the reader ("1 remote image blocked")
		// and loading one would reveal nothing.
		if (!hidden) blockedImageCount++;
	}

	const clean = container.innerHTML;
	if (clean.trim() === '') return null;
	return {
		html: clean,
		blockedImageCount,
		hasVisibleText: hasVisibleText(container),
		hasLoadableImage
	};
}
