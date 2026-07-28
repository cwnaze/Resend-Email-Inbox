<script lang="ts">
	/**
	 * One message inside a thread (US-G01).
	 *
	 * Per the design system (tasks/prd-feature-thread-view.md § Design
	 * Considerations): all metadata — sender address, recipients, timestamp — in
	 * the monospace face, the body in the humanist sans at a comfortable reading
	 * measure, and a thin 1px divider between messages rather than a card with a
	 * shadow.
	 *
	 * The body arrives as plain text (the load de-tags an HTML-only body). It is
	 * rendered as text, never with `{@html}`: US-G02 is what introduces real HTML
	 * rendering, and it does so inside a sandboxed iframe rather than in this
	 * document.
	 */
	// Deliberately narrower than the load's message shape: `id` is the `#each`
	// key in the parent and nothing this component renders, and
	// `svelte/no-unused-props` (correctly) rejects declaring a field a component
	// doesn't use.
	interface Props {
		message: {
			sender: string;
			fromEmail: string;
			to: string;
			cc: string;
			receivedAt: Date;
			timestamp: string;
			body: string;
		};
	}

	const { message }: Props = $props();

	// Only worth a second line when the display name isn't already the address.
	const showAddress = $derived(message.sender !== message.fromEmail);
</script>

<article class="border-b border-border px-4 py-5 last:border-b-0 sm:px-6">
	<header class="flex flex-col gap-1">
		<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
			<h3 class="min-w-0 text-sm font-medium text-text-primary">{message.sender}</h3>
			<time
				datetime={message.receivedAt.toISOString()}
				class="shrink-0 font-mono text-xs text-text-muted"
			>
				{message.timestamp}
			</time>
		</div>

		<dl class="flex flex-col gap-0.5 font-mono text-xs text-text-muted">
			{#if showAddress}
				<div class="flex gap-1.5">
					<dt class="shrink-0">from</dt>
					<dd class="min-w-0 break-all">{message.fromEmail}</dd>
				</div>
			{/if}
			{#if message.to}
				<div class="flex gap-1.5">
					<dt class="shrink-0">to</dt>
					<dd class="min-w-0 break-all">{message.to}</dd>
				</div>
			{/if}
			{#if message.cc}
				<div class="flex gap-1.5">
					<dt class="shrink-0">cc</dt>
					<dd class="min-w-0 break-all">{message.cc}</dd>
				</div>
			{/if}
		</dl>
	</header>

	{#if message.body}
		<!--
			`whitespace-pre-wrap` keeps the message's own line breaks (a plain-text
			body is authored with them) while still wrapping to the reading measure;
			`break-words` stops a long unbroken URL from forcing horizontal scroll.
		-->
		<p
			class="mt-3 max-w-[72ch] font-sans text-sm leading-relaxed break-words whitespace-pre-wrap text-text-primary"
		>
			{message.body}
		</p>
	{:else}
		<p class="mt-3 font-sans text-sm text-text-muted italic">This message has no body.</p>
	{/if}
</article>
