<script lang="ts">
	/**
	 * The inbox thread list (US-F01).
	 *
	 * Renders full-width in the shell's main pane: the shell has no list
	 * column of its own (US-F01 removed the placeholder one — see
	 * `(app)/+layout.svelte`).
	 *
	 * US-F01/F02 expected US-G01 to move this list into an
	 * `inbox/+layout.svelte` beside the thread view. US-G01 built the thread
	 * view full-width instead and **deferred the split**: a layout load runs in
	 * parallel with the page load it wraps, so a list living in the layout would
	 * render from a snapshot taken before the thread page's `markThreadRead`
	 * (US-F02) committed — the row you just opened would keep its unread dot
	 * until some later navigation. Making the split correct means resolving that
	 * ordering first (a form action, or an explicit invalidation), which belongs
	 * with US-G04's mark-read-on-view criterion rather than here.
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
	Capped and centered while the list has the full pane to itself. The cap stops
	applying if the deferred list/detail split (see above) ever moves this into a
	fixed-width column.
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
