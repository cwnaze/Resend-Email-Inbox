<script lang="ts">
	/**
	 * The thread view's error boundary (US-G01): an unknown thread id, or a
	 * thread whose every message is soft-deleted, `error(404)`s in the load and
	 * lands here.
	 *
	 * Scoped to this route rather than to the `(app)` group so the copy can be
	 * specific ("this thread", not "this page") and can offer the one action that
	 * actually helps — going back to the list. It renders inside the app shell,
	 * because only the *page* load failed; the layout's session check passed.
	 */
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import ErrorMessage from '$lib/components/ErrorMessage.svelte';

	const isMissing = $derived(page.status === 404);
</script>

<section class="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-10">
	{#if isMissing}
		<EmptyState
			message="This thread isn’t here"
			subCopy="It may have been deleted, or the link may be out of date."
		/>
	{:else}
		<ErrorMessage message={page.error?.message ?? 'Something went wrong loading this thread.'} />
	{/if}

	<a
		href={resolve('/(app)/inbox')}
		class="mt-4 font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-accent"
	>
		← Back to inbox
	</a>
</section>
