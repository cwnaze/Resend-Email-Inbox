<script lang="ts">
	/**
	 * One thread in the inbox list (US-F01).
	 *
	 * Per the design system: a thin 1px divider rather than a card with a
	 * shadow, sender/subject in the humanist sans, and snippet + timestamp in
	 * the monospace face (the Dusk Terminal signature detail, prd-ui-ux FR-2).
	 *
	 * Read threads render in the muted tone and unread ones in the primary tone
	 * at a heavier weight, with a sage accent dot in the gutter (US-F02). The
	 * dot's slot is reserved on read rows too, so a read row's text doesn't
	 * shift left relative to an unread one.
	 */
	import { resolve } from '$app/paths';
	import { relativeTime } from '$lib/inbox/format';

	let {
		thread
	}: {
		thread: {
			id: string;
			subject: string;
			sender: string;
			senderEmail: string;
			snippet: string;
			messageCount: number;
			isRead: boolean;
			lastMessageAt: Date;
		};
	} = $props();

	// Recomputed on render rather than ticked on a timer: a relative label this
	// coarse ("2h ago") does not need a per-second interval for every row.
	const timestamp = $derived(relativeTime(thread.lastMessageAt));
</script>

<!--
	`preload-data="tap"` overrides the app-wide `hover` default from `app.html`
	on purpose: this link's load marks the thread read (US-F02), so preloading
	on hover would clear the unread state of every row the pointer crosses.
-->
<a
	href={resolve('/(app)/inbox/[threadId]', { threadId: thread.id })}
	data-sveltekit-preload-data="tap"
	class="flex gap-2 border-b border-border px-4 py-3 transition-colors duration-fast ease-standard hover:bg-surface focus-visible:bg-surface focus-visible:outline-none"
>
	<!--
		The gutter keeps its width whether or not the dot is drawn, so switching a
		row from unread to read doesn't shift its text sideways.
	-->
	<span class="mt-1.5 h-2 w-2 shrink-0" aria-hidden="true">
		<!--
			`rounded-[50%]` rather than `rounded-full`: this app overrides the whole
			Tailwind radius namespace to 2-4px (see `layout.css`), so `rounded-full`
			would render a barely-rounded square here.
		-->
		{#if !thread.isRead}
			<span class="block h-2 w-2 rounded-[50%] bg-accent"></span>
		{/if}
	</span>

	<div class="min-w-0 flex-1">
		<!-- The dot is decorative, so the unread state needs a text equivalent too. -->
		{#if !thread.isRead}
			<span class="sr-only">Unread.</span>
		{/if}

		<div class="flex items-baseline gap-2">
			<span
				title={thread.senderEmail}
				class="min-w-0 flex-1 truncate text-sm {thread.isRead
					? 'font-normal text-text-muted'
					: 'font-semibold text-text-primary'}"
			>
				{thread.sender}
			</span>
			{#if thread.messageCount > 1}
				<span class="shrink-0 font-mono text-xs text-text-muted">{thread.messageCount}</span>
			{/if}
			<time
				datetime={thread.lastMessageAt.toISOString()}
				class="shrink-0 font-mono text-xs text-text-muted"
			>
				{timestamp}
			</time>
		</div>

		<p
			class="mt-0.5 truncate text-sm {thread.isRead
				? 'text-text-muted'
				: 'font-medium text-text-primary'}"
		>
			{thread.subject}
		</p>

		{#if thread.snippet}
			<p class="mt-1 truncate font-mono text-xs text-text-muted">
				{thread.snippet}
			</p>
		{/if}
	</div>
</a>
