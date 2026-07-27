<script lang="ts">
	/**
	 * The inbox thread list (US-F01).
	 *
	 * Renders in the shell's main pane. US-G01 introduces the thread detail
	 * view and hoists this list into the shell's left `<aside>` column so the
	 * two panes are list + detail; keeping it here for now avoids inventing a
	 * layout-level data load for a pane that has nothing to sit beside yet.
	 *
	 * Read/unread styling (US-F02), the read filter (US-F03) and search
	 * (US-F04) all layer onto this list rather than replacing it.
	 */
	import EmptyState from '$lib/components/EmptyState.svelte';
	import ThreadRow from './ThreadRow.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<!--
	Capped and centered only while the list has the full pane to itself; US-G01
	moves it into a fixed-width column beside the thread view, where the cap
	stops applying.
-->
<section class="mx-auto flex min-h-full w-full max-w-3xl flex-col">
	<h1 class="sr-only">Inbox</h1>

	{#if data.threads.length === 0}
		<div class="flex flex-1 items-center justify-center p-8">
			<EmptyState message="Nothing here yet" subCopy="New mail will show up here." />
		</div>
	{:else}
		<ul class="flex flex-col">
			{#each data.threads as thread (thread.id)}
				<li>
					<ThreadRow {thread} />
				</li>
			{/each}
		</ul>
	{/if}
</section>
