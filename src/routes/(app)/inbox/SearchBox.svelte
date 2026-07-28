<script lang="ts">
	/**
	 * The subject/sender search box (US-F04).
	 *
	 * A plain `method="GET"` form, no JS of our own: submitting navigates to
	 * `?q=…`, which is the whole feature — the URL is the state (FR-3), so a
	 * refresh, a back-navigation and a shared link reproduce the same results,
	 * and the narrowing happens in the load's query rather than by hiding rows
	 * the client already has. Same reasoning as `FilterTabs.svelte` using real
	 * links instead of buttons.
	 *
	 * The search lives here rather than in the `(app)` shell's top bar (where
	 * US-J02 put a non-functional placeholder input, removed by this story) for
	 * the same reason US-F01 took the placeholder thread list out of the shell:
	 * searching threads is part of the inbox subtree, and a future `/contacts`
	 * page would otherwise inherit a box that searches a list it isn't showing.
	 */
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { MAX_INBOX_QUERY_LENGTH, INBOX_SEARCH_PARAM, inboxSearchSearch } from '$lib/inbox/search';
	import { DEFAULT_INBOX_FILTER, INBOX_FILTER_PARAM, type InboxFilter } from '$lib/inbox/filter';

	let { query, filter }: { query: string; filter: InboxFilter } = $props();

	// A GET submit replaces the entire query string with this form's fields, so
	// the active filter has to ride along as a hidden input or searching would
	// silently reset the view to All (FR-3 wants both at once).
	const filterValue = $derived(filter === DEFAULT_INBOX_FILTER ? null : filter);

	// Clearing goes through `inboxSearchSearch` so it *drops* `?q=` rather than
	// leaving an empty one behind, and keeps the filter.
	const clearSearch = $derived(inboxSearchSearch(page.url.searchParams, ''));
</script>

<form
	method="GET"
	action={resolve('/(app)/inbox')}
	role="search"
	data-sveltekit-keepfocus
	class="flex items-center gap-2 border-b border-border px-4 py-2"
>
	{#if filterValue !== null}
		<input type="hidden" name={INBOX_FILTER_PARAM} value={filterValue} />
	{/if}

	<label class="sr-only" for="inbox-search">Search by subject or sender</label>
	<input
		id="inbox-search"
		type="search"
		name={INBOX_SEARCH_PARAM}
		value={query}
		maxlength={MAX_INBOX_QUERY_LENGTH}
		placeholder="Search subject or sender"
		autocomplete="off"
		class="min-w-0 flex-1 rounded border border-border bg-surface px-2.5 py-1.5 font-mono text-sm text-text-primary transition-colors duration-fast ease-standard placeholder:text-text-muted focus:border-accent focus:outline-none"
	/>

	<button
		type="submit"
		class="shrink-0 rounded border border-border bg-surface px-3 py-1.5 font-mono text-xs text-text-primary transition-colors duration-fast ease-standard hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:outline-none"
	>
		Search
	</button>

	{#if query !== ''}
		<!--
			`resolve()` has to sit in the `href` expression itself —
			`svelte/no-navigation-without-resolve` inspects the attribute, so a
			precomputed href fails lint. Only the query string is derived.
		-->
		<a
			href="{resolve('/(app)/inbox')}{clearSearch}"
			class="shrink-0 rounded px-2 py-1 font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-text-primary focus-visible:text-text-primary focus-visible:outline-none"
		>
			Clear
		</a>
	{/if}
</form>
