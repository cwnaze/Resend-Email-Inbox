<script lang="ts">
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	const palette = [
		{ name: 'background', class: 'bg-background' },
		{ name: 'surface', class: 'bg-surface' },
		{ name: 'border', class: 'bg-border' },
		{ name: 'text-primary', class: 'bg-text-primary' },
		{ name: 'text-muted', class: 'bg-text-muted' },
		{ name: 'accent', class: 'bg-accent' },
		{ name: 'accent-secondary', class: 'bg-accent-secondary' },
		{ name: 'danger', class: 'bg-danger' }
	];

	const radii = [
		{ name: 'rounded-sm (2px)', class: 'rounded-sm' },
		{ name: 'rounded (3px)', class: 'rounded' },
		{ name: 'rounded-lg (4px)', class: 'rounded-lg' }
	];
</script>

<svelte:head>
	<title>Dusk Terminal — design tokens</title>
</svelte:head>

<main class="min-h-screen bg-background p-8 text-text-primary">
	<div class="mx-auto flex max-w-3xl flex-col gap-8">
		<header class="flex items-center justify-between">
			<h1 class="font-sans text-2xl font-semibold">Dusk Terminal design tokens</h1>
			<ThemeToggle />
		</header>

		<section>
			<h2 class="mb-3 font-sans text-sm font-medium text-text-muted">Palette</h2>
			<ul class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{#each palette as swatch (swatch.name)}
					<li class="flex flex-col gap-2">
						<div class="h-16 rounded border border-border {swatch.class}"></div>
						<span class="font-mono text-xs text-text-muted">{swatch.name}</span>
					</li>
				{/each}
			</ul>
		</section>

		<section>
			<h2 class="mb-3 font-sans text-sm font-medium text-text-muted">Typography</h2>
			<p class="font-sans text-base">
				Humanist sans (Inter) is used for prose, navigation, and buttons.
			</p>
			<p class="font-mono text-sm text-text-muted">
				Monospace (JetBrains Mono) is used for metadata — 2026-07-23T12:00:00Z · casey@example.com ·
				thread_9f2a
			</p>
		</section>

		<section>
			<h2 class="mb-3 font-sans text-sm font-medium text-text-muted">Radius scale</h2>
			<div class="flex gap-4">
				{#each radii as radius (radius.name)}
					<div class="flex flex-col items-center gap-2">
						<div class="h-12 w-12 border border-accent bg-surface {radius.class}"></div>
						<span class="font-mono text-xs text-text-muted">{radius.name}</span>
					</div>
				{/each}
			</div>
		</section>

		<section>
			<h2 class="mb-3 font-sans text-sm font-medium text-text-muted">Motion</h2>
			<button
				type="button"
				class="w-fit rounded border border-border bg-surface px-4 py-2 font-sans text-sm transition-colors duration-fast ease-standard hover:border-accent hover:text-accent"
			>
				Hover me (120ms ease-out)
			</button>
		</section>
	</div>
</main>
