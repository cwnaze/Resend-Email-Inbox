<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { initTheme } from '$lib/theme.svelte';

	let { children } = $props();

	initTheme();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}
