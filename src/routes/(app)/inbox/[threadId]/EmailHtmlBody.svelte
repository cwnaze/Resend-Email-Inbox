<script lang="ts">
	/**
	 * An HTML email body, rendered inside a sandboxed iframe (US-G02).
	 *
	 * Three things carry the safety of this component and none is negotiable:
	 *
	 * - `sandbox="allow-same-origin"` **without** `allow-scripts`. No script in a
	 *   stored body executes and no form submits. `allow-same-origin` is present so
	 *   *this* side can reach into `contentDocument` — to size the frame, and to
	 *   intercept link clicks (below); since scripting is off inside, nothing in
	 *   there can use the shared origin for anything.
	 * - The body arrives with remote image `src`s already moved aside
	 *   (`$lib/server/inbox/html.ts`). Clicking "Load images" puts them back for
	 *   this one message only, per FR-3 — there is deliberately no app-wide
	 *   "always load images" setting to flip.
	 * - **Links cannot take the frame over.** A sandbox with no `allow-popups` does
	 *   *not* make links inert: a plain `<a href>` navigates the frame *itself*,
	 *   which sandbox always permits, so a phishing link would replace the message
	 *   with the attacker's page inside this app's chrome (and take the frame
	 *   cross-origin, silently killing the height measurement with it). What
	 *   prevents that is the `<base target="_blank">` the srcdoc carries: opening a
	 *   new context is what the sandbox blocks. That guarantee is declarative and
	 *   needs no JS. `interceptLinkClick` below is the *upgrade* — it turns the
	 *   resulting "nothing happens" into a real new tab — so it must never become
	 *   the only thing standing between a reader and a frame takeover.
	 */
	import { buildEmailSrcdoc } from '$lib/inbox/srcdoc';

	interface Props {
		/** Sanitized markup with remote images already blocked. */
		html: string;
		/** How many images were blocked; 0 hides the toggle. */
		blockedImageCount: number;
		/** Accessible name for the frame, e.g. the sender's label. */
		title: string;
	}

	const { html, blockedImageCount, title }: Props = $props();

	let showImages = $state(false);
	let frame = $state<HTMLIFrameElement>();
	// A first guess, so the frame doesn't flash at zero height before it is
	// measured. Replaced as soon as the document is readable.
	let height = $state(120);
	let observer: ResizeObserver | undefined;
	let listeningTo: Document | undefined;

	const srcdoc = $derived(buildEmailSrcdoc(html, { showImages }));

	function measure() {
		const body = frame?.contentDocument?.body;
		if (!body) return;
		// The content's height has to come from the **body**, not from
		// `documentElement.scrollHeight`: the root element's scroll height is floored
		// at the frame's own viewport height, so it reports back whatever height we
		// last set. Measuring it would make the frame able to grow and never shrink
		// (a reflow that gets shorter would leave the blank space behind forever) and
		// would pad every short message out to the initial guess. The srcdoc
		// stylesheet zeroes the body margin, so its box *is* the content.
		height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height, 24));
	}

	/** Opens a clicked link in a new tab instead of letting it take over the frame. */
	function interceptLinkClick(event: MouseEvent) {
		// Duck-typed, **not** `event.target instanceof Element`: the frame is its own
		// realm with its own `Element` constructor, so an `instanceof` against this
		// document's `Element` is always false for a node from inside the frame — the
		// guard would swallow every click and let the navigation through, which is
		// exactly the bug it looks like it prevents.
		const target = event.target as Element | null;
		const link = typeof target?.closest === 'function' ? target.closest('a[href]') : null;
		const href = link?.getAttribute('href');
		if (!href) return;

		// Cancel regardless of what the href turns out to be: the `<base>` already
		// means the frame can't navigate itself, and cancelling keeps that true even
		// for the hrefs this handler declines to open.
		event.preventDefault();

		// Only an absolute http(s) URL is worth a new tab. A relative path or a bare
		// `#anchor` — both of which survive sanitization, and a newsletter
		// "back to top" link is exactly the latter — would resolve against *this*
		// app's origin and open a pointless tab showing our own inbox. A stored
		// email body has no meaningful base URL of its own, so there is nothing
		// sensible to resolve them against.
		if (!/^https?:\/\//i.test(href.trim())) return;

		// `noopener` because the opened page is not sandboxed and must not get a
		// handle back to this window.
		window.open(href, '_blank', 'noopener,noreferrer');
	}

	/**
	 * Measures the frame, then keeps watching it: an image finishing its download
	 * after `load` fired is the common case, and it is precisely what "sized to
	 * content height" has to survive.
	 */
	function attach() {
		const doc = frame?.contentDocument;
		if (!doc) return;

		measure();

		observer?.disconnect();
		if (doc.body && typeof ResizeObserver !== 'undefined') {
			observer = new ResizeObserver(measure);
			// Observe the body, matching what `measure` reads — observing the root
			// element instead means every height write resizes the observed box, which
			// is what produces Chrome's "ResizeObserver loop completed" warning.
			observer.observe(doc.body);
		}

		if (listeningTo !== doc) {
			listeningTo?.removeEventListener('click', interceptLinkClick);
			doc.addEventListener('click', interceptLinkClick);
			listeningTo = doc;
		}
	}

	// `onload` alone is not enough. On a server-rendered page (a bookmarked thread
	// URL, or any hard refresh) the srcdoc document can finish loading before
	// hydration attaches the handler, and `load` fires once — so the frame would
	// keep the 120px guess forever. Reading `frame` makes this run when the element
	// is bound; if the document is already there, measure it now.
	$effect(() => {
		if (frame?.contentDocument?.readyState === 'complete') attach();
		return () => {
			observer?.disconnect();
			listeningTo?.removeEventListener('click', interceptLinkClick);
			listeningTo = undefined;
		};
	});
</script>

<div class="mt-3">
	{#if blockedImageCount > 0 && !showImages}
		<div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
			<p class="font-mono text-xs text-text-muted">
				{blockedImageCount}
				{blockedImageCount === 1 ? 'remote image' : 'remote images'} blocked
			</p>
			<button
				type="button"
				class="rounded border border-border px-2 py-1 font-mono text-xs text-accent transition-colors duration-fast ease-standard hover:border-accent focus-visible:border-accent focus-visible:outline-none"
				onclick={() => (showImages = true)}
			>
				Load images
			</button>
		</div>
	{/if}

	<!--
		`srcdoc` (not `src`) keeps the body out of any URL and off the network.
		`referrerpolicy` is belt-and-braces for the images-loaded state: the
		sender should not learn which URL was open when their pixel fired.
	-->
	<iframe
		bind:this={frame}
		{title}
		{srcdoc}
		sandbox="allow-same-origin"
		referrerpolicy="no-referrer"
		onload={attach}
		class="block w-full max-w-[72ch] border-0 bg-white"
		style="height: {height}px"
	></iframe>
</div>
