<script lang="ts">
	/**
	 * An HTML email body, rendered inside a sandboxed iframe (US-G02).
	 *
	 * Two things carry the safety of this component and neither is negotiable:
	 *
	 * - `sandbox="allow-same-origin"` **without** `allow-scripts`. No script in a
	 *   stored body executes, no form submits, and the frame can't navigate this
	 *   document. `allow-same-origin` is present only so *this* side can read
	 *   `contentDocument` to size the frame to its content; since scripting is off
	 *   inside, nothing in there can use the shared origin for anything.
	 * - The body arrives with remote image `src`s already moved aside
	 *   (`$lib/server/inbox/html.ts`). Clicking "Load images" puts them back for
	 *   this one message only, per FR-3 — there is deliberately no app-wide
	 *   "always load images" setting to flip.
	 *
	 * Links inside the frame are inert: opening one would need `allow-popups`,
	 * which the story's sandbox list doesn't include. That's a known limitation,
	 * not an oversight.
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
	// A first guess, so the frame doesn't flash at zero height before its load
	// event. Replaced by the measured height as soon as the document is there.
	let height = $state(120);
	let observer: ResizeObserver | undefined;

	const srcdoc = $derived(buildEmailSrcdoc(html, { showImages }));

	function measure() {
		const doc = frame?.contentDocument;
		if (!doc?.documentElement) return;
		// `scrollHeight` of the root element is the content's own height; the body
		// has no margin (the srcdoc stylesheet zeroes it) so there's nothing to add.
		height = Math.max(doc.documentElement.scrollHeight, 24);
	}

	/**
	 * Re-measures once the document exists, and again whenever it reflows — an
	 * image finishing its download after `load` fired is the common case, and it
	 * is precisely what "sized to content height" has to survive.
	 */
	function handleLoad() {
		measure();
		observer?.disconnect();
		const doc = frame?.contentDocument;
		if (!doc?.body || typeof ResizeObserver === 'undefined') return;
		observer = new ResizeObserver(measure);
		observer.observe(doc.documentElement);
	}

	$effect(() => () => observer?.disconnect());
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
				class="rounded border border-border px-2 py-1 font-mono text-xs text-accent transition-colors duration-fast ease-standard hover:border-accent"
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
		onload={handleLoad}
		class="block w-full max-w-[72ch] border-0 bg-white"
		style="height: {height}px"
	></iframe>
</div>
