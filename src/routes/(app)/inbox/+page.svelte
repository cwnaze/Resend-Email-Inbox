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
	import FilterTabs from './FilterTabs.svelte';
	import SearchBox from './SearchBox.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// An empty list means something different under a search or a filter than in
	// a genuinely empty inbox, and "New mail will show up here" would be
	// misleading advice when the mail exists and is simply narrowed out. A search
	// with no hits takes precedence over the filter copy: the query is what the
	// owner just typed, so it's the likelier thing to adjust.
	function emptyStateCopy(query: string, filter: PageData['filter']) {
		if (query !== '') {
			return {
				message: 'No matching threads',
				subCopy: `Nothing matches “${query}” in a subject or sender.`
			};
		}
		if (filter === 'unread') {
			return { message: 'Nothing unread', subCopy: 'Every thread has been read.' };
		}
		if (filter === 'read') {
			return { message: 'Nothing read yet', subCopy: 'Threads you open will show up here.' };
		}
		return { message: 'Nothing here yet', subCopy: 'New mail will show up here.' };
	}

	const emptyCopy = $derived(emptyStateCopy(data.query, data.filter));
</script>

<!--
	Capped and centered only while the list has the full pane to itself; US-G01
	moves it into a fixed-width column beside the thread view, where the cap
	stops applying.
-->
<section class="mx-auto flex min-h-full w-full max-w-3xl flex-col">
	<h1 class="sr-only">Inbox</h1>

	<SearchBox query={data.query} filter={data.filter} />
	<FilterTabs current={data.filter} />

	{#if data.threads.length === 0}
		<div class="flex flex-1 items-center justify-center p-8">
			<EmptyState message={emptyCopy.message} subCopy={emptyCopy.subCopy} />
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
