<script lang="ts">
	/**
	 * App shell for every route under the (app) group: a top bar (app mark,
	 * search entry point, logout) plus a two-pane list/detail layout on
	 * desktop (>=1024px, Tailwind's `lg` breakpoint) that collapses to a
	 * single-pane stack below that, with no horizontal scroll down to 375px.
	 *
	 * The left "list" column is a structural placeholder for now — the real
	 * thread list lands in US-F01 and will replace the placeholder content,
	 * not the shell around it. It's hidden below `lg` so mobile/tablet get
	 * the single-pane stack the design calls for; a dedicated mobile list
	 * view is out of scope for this story.
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
		<aside
			class="hidden w-[360px] shrink-0 flex-col overflow-y-auto border-r border-border lg:flex"
		>
			<p class="p-4 font-mono text-sm text-text-muted">Thread list — coming in a later story.</p>
		</aside>

		<main class="min-w-0 flex-1 overflow-y-auto">
			{@render children()}
		</main>
	</div>
</div>
