<script lang="ts">
	/**
	 * The All / Unread / Read filter control (US-F03).
	 *
	 * Real `<a>` links, not buttons with client-side state: the filter lives in
	 * the URL (`?filter=unread`), so it has to survive a refresh and be
	 * reachable by back-navigation, and links give that plus keyboard and
	 * middle-click behaviour for free with no JS of our own.
	 */
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		INBOX_FILTERS,
		inboxFilterLabel,
		inboxFilterSearch,
		type InboxFilter
	} from '$lib/inbox/filter';

	let { current }: { current: InboxFilter } = $props();

	// Built off the live URL rather than from scratch so US-F04's `?q=` (FR-3)
	// isn't dropped when the filter changes.
	const links = $derived(
		INBOX_FILTERS.map((filter) => ({
			filter,
			label: inboxFilterLabel(filter),
			search: inboxFilterSearch(page.url.searchParams, filter)
		}))
	);
</script>

<nav aria-label="Filter threads" class="flex items-center gap-1 border-b border-border px-4 py-2">
	{#each links as link (link.filter)}
		<!--
			The `resolve()` call has to sit in the `href` attribute itself —
			`svelte/no-navigation-without-resolve` inspects the attribute expression,
			so precomputing a full href above and passing it down fails lint. Only
			the query string is derived.

			`aria-current="true"` rather than `"page"`: all three links address the
			same page, so "page" would be asserted by whichever one is active for a
			reason that isn't really about location.
		-->
		<a
			href="{resolve('/(app)/inbox')}{link.search}"
			aria-current={link.filter === current ? 'true' : undefined}
			class="rounded px-2 py-1 font-mono text-xs transition-colors duration-fast ease-standard hover:bg-surface focus-visible:bg-surface focus-visible:outline-none {link.filter ===
			current
				? 'bg-surface font-medium text-text-primary'
				: 'text-text-muted'}"
		>
			{link.label}
		</a>
	{/each}
</nav>
