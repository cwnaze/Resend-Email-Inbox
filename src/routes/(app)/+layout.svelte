<script lang="ts">
	/**
	 * App shell for every route under the (app) group: a top bar (app mark,
	 * search entry point, logout) above the routed content, with no
	 * horizontal scroll down to 375px.
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

		<form role="search" class="mx-auto min-w-0 flex-1 sm:max-w-sm">
			<label class="sr-only" for="app-shell-search">Search threads</label>
			<input
				id="app-shell-search"
				type="search"
				name="q"
				placeholder="Search"
				class="w-full min-w-0 rounded border border-border bg-surface px-2.5 py-1.5 font-mono text-sm text-text-primary transition-colors duration-fast ease-standard placeholder:text-text-muted focus:border-accent focus:outline-none"
			/>
		</form>

		<form method="POST" action="/api/auth/logout" class="shrink-0">
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
