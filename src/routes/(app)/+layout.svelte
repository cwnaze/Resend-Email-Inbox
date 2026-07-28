<script lang="ts">
	/**
	 * App shell for every route under the (app) group: a top bar (app mark,
	 * logout) above the routed content, with no horizontal scroll down to
	 * 375px.
	 *
	 * US-J02's top bar also held a non-functional placeholder search input.
	 * US-F04 removed it and put the real search box in the inbox subtree
	 * (`inbox/SearchBox.svelte`), for the same reason the placeholder thread
	 * list left this file: it searches the *inbox list*, so a `/contacts` page
	 * must not inherit it.
	 *
	 * US-J02 stood this up with a fixed 360px left column holding a
	 * placeholder for the thread list. US-F01 removed that column: the
	 * thread list is part of the *inbox* subtree, not of every `(app)`
	 * route (a future `/contacts` page would have inherited an inbox list
	 * beside it), so the list/detail split belongs in `inbox/+layout.svelte`
	 * once US-G01 gives it a detail pane to sit beside. Until then the
	 * routed page gets the full width.
	 */
	import { resolve } from '$app/paths';

	let { children } = $props();
</script>

<div class="flex h-dvh min-w-0 flex-col bg-background text-text-primary">
	<header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-4">
		<a
			href={resolve('/inbox')}
			class="shrink-0 font-mono text-sm font-medium tracking-wide text-text-primary transition-colors duration-fast ease-standard hover:text-accent"
		>
			dusk // inbox
		</a>

		<form method="POST" action="/api/auth/logout" class="ml-auto shrink-0">
			<button
				type="submit"
				class="rounded border border-border bg-surface px-3 py-1.5 text-sm text-text-primary transition-colors duration-fast ease-standard hover:border-danger hover:text-danger"
			>
				Log out
			</button>
		</form>
	</header>

	<div class="flex min-h-0 min-w-0 flex-1">
		<main class="min-w-0 flex-1 overflow-y-auto">
			{@render children()}
		</main>
	</div>
</div>
