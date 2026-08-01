<script lang="ts">
	/**
	 * The contacts list (US-I01) — everyone the owner has corresponded with,
	 * auto-populated by the inbound webhook and the send path (US-E02/US-H02).
	 *
	 * Full-width in the shell's main pane and capped like the inbox list, so the
	 * two read as the same kind of view. US-I02 (edit) and US-I03 (add) hang off
	 * this page rather than a new one.
	 */
	import EmptyState from '$lib/components/EmptyState.svelte';
	import ContactRow from './ContactRow.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<section class="mx-auto flex min-h-full w-full max-w-3xl flex-col">
	<h1 class="border-b border-border px-4 py-3 text-sm font-semibold text-text-primary">Contacts</h1>

	{#if data.contacts.length === 0}
		<div class="flex flex-1 items-center justify-center p-8">
			<EmptyState
				message="No contacts yet"
				subCopy="Everyone you email — or who emails you — shows up here."
			/>
		</div>
	{:else}
		<ul class="flex flex-col">
			{#each data.contacts as contact (contact.id)}
				<li>
					<ContactRow {contact} />
				</li>
			{/each}
		</ul>
	{/if}
</section>
