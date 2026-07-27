<script lang="ts">
	interface Props {
		/** Number of pulsing placeholder rows to render for list-shaped content. */
		rows?: number;
	}

	const { rows = 3 }: Props = $props();

	const rowIndices = $derived(Array.from({ length: rows }, (_, i) => i));
</script>

<div class="flex flex-col gap-2" role="status" aria-label="Loading">
	{#each rowIndices as i (i)}
		<div class="h-12 animate-pulse rounded bg-surface"></div>
	{/each}
</div>
