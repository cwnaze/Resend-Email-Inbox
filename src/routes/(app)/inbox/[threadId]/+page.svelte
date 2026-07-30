<script lang="ts">
	/**
	 * The thread reading view (US-G01): every visible message in the thread,
	 * oldest first.
	 *
	 * This renders full-width in the shell's main pane. US-F01/F02's notes
	 * anticipated an `inbox/+layout.svelte` list/detail split landing here, and
	 * it is deliberately *not* part of this story — see the note in
	 * `../+page.svelte` for why it needs the mark-read side effect resolved
	 * first.
	 */
	import { resolve } from '$app/paths';
	import ThreadMessage from './ThreadMessage.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.subject || 'Thread'} — dusk inbox</title>
</svelte:head>

<section class="mx-auto flex w-full max-w-3xl flex-col">
	<header class="border-b border-border px-4 py-4 sm:px-6">
		<a
			href={resolve('/(app)/inbox')}
			class="font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-accent"
		>
			← Inbox
		</a>
		<h1 class="mt-2 text-base font-semibold text-text-primary">{data.subject || '(no subject)'}</h1>
		<p class="mt-1 font-mono text-xs text-text-muted">
			{data.messages.length}
			{data.messages.length === 1 ? 'message' : 'messages'}
		</p>
	</header>

	<div class="flex flex-col">
		{#each data.messages as message (message.id)}
			<ThreadMessage threadId={data.threadId} {message} />
		{/each}
	</div>
</section>
