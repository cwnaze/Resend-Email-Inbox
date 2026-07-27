<script lang="ts">
	interface Props {
		/** Number of pulsing placeholder rows to render for list-shaped content. */
		rows?: number;
	}

	const { rows = 3 }: Props = $props();

	// Iterate an explicit index array rather than `{#each { length: rows } as _, i}` —
	// the placeholder `_` trips @typescript-eslint/no-unused-vars in this config.
	const indices = $derived(Array.from({ length: rows }, (_, i) => i));
</script>

<div class="flex flex-col gap-2" role="status" aria-label="Loading">
	{#each indices as i (i)}
		<div class="h-12 rounded bg-surface motion-safe:animate-pulse"></div>
	{/each}
</div>
