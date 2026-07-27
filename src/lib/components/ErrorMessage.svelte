<script lang="ts">
	interface Props {
		message: string;
		onRetry?: () => void;
	}

	const { message, onRetry }: Props = $props();
</script>

<div class="flex items-center gap-3 font-sans text-sm text-danger">
	<span role="alert">{message}</span>
	{#if onRetry}
		<button
			type="button"
			onclick={onRetry}
			class="rounded border border-danger px-2 py-0.5 font-mono text-xs text-danger transition-colors duration-fast ease-standard hover:bg-danger hover:text-background"
		>
			Retry
		</button>
	{/if}
</div>
