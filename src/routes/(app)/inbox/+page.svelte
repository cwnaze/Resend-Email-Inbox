<script lang="ts">
	/**
	 * The inbox thread list (US-F01).
	 *
	 * Renders full-width in the shell's main pane: the shell has no list
	 * column of its own (US-F01 removed the placeholder one — see
	 * `(app)/+layout.svelte`). US-G01 introduces the thread detail view and
	 * with it an `inbox/+layout.svelte` holding the list/detail split, at
	 * which point this list moves into that layout's fixed-width column.
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
