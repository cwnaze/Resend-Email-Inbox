<script lang="ts">
	interface Props {
		message: string;
		subCopy?: string;
	}

	const { message, subCopy }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center">
	<p class="font-sans text-sm text-text-primary">{message}</p>
	{#if subCopy}
		<p class="font-sans text-xs text-text-muted">{subCopy}</p>
	{/if}
</div>
