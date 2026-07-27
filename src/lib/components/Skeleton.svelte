<script lang="ts">
	interface Props {
		/** Number of pulsing placeholder rows to render for list-shaped content. */
		rows?: number;
	}

	const { rows = 3 }: Props = $props();
</script>

<div class="flex flex-col gap-2" role="status" aria-label="Loading">
	{#each { length: rows } as _, i (i)}
		<div class="h-12 rounded bg-surface motion-safe:animate-pulse"></div>
	{/each}
</div>
