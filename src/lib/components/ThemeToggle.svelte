<script lang="ts">
	import { themeState, toggleTheme } from '$lib/theme.svelte';

	const label = $derived(
		themeState.current === 'light' ? 'Switch to dark theme' : 'Switch to light theme'
	);
</script>

<button
	type="button"
	onclick={toggleTheme}
	aria-label={label}
	title={label}
	class="rounded border border-border bg-surface px-3 py-1.5 font-mono text-sm text-text-primary transition-colors duration-fast ease-standard hover:border-accent"
>
	{themeState.current === 'light' ? '☀︎ light' : '☾ dark'}
</button>
