<script lang="ts">
	/**
	 * One thread in the inbox list (US-F01).
	 *
	 * Per the design system: a thin 1px divider rather than a card with a
	 * shadow, sender/subject in the humanist sans, and snippet + timestamp in
	 * the monospace face (the Dusk Terminal signature detail, prd-ui-ux FR-2).
	 *
	 * Read threads render in the muted tone and unread ones in the primary tone
	 * at a heavier weight. The rest of the unread treatment — the sage accent
	 * dot, and recomputing `threads.is_read` on open — is US-F02's story, which
	 * layers onto this markup rather than restructuring it.
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

<a
	href={resolve('/(app)/inbox/[threadId]', { threadId: thread.id })}
	class="block border-b border-border px-4 py-3 transition-colors duration-fast ease-standard hover:bg-surface focus-visible:bg-surface focus-visible:outline-none"
>
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

	<p class="mt-0.5 truncate text-sm {thread.isRead ? 'text-text-muted' : 'text-text-primary'}">
		{thread.subject}
	</p>

	{#if thread.snippet}
		<p class="mt-1 truncate font-mono text-xs text-text-muted">
			{thread.snippet}
		</p>
	{/if}
</a>
