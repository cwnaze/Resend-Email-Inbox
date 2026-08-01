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
	import AddContactForm from './AddContactForm.svelte';
	import ContactRow from './ContactRow.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// `form` is the union of every action's failure payload, so which form the
	// message belongs to has to be decided before any other field is read —
	// hence the `intent` discriminant rather than sniffing for a key.
	const addFailure = $derived(form?.intent === 'add' ? form : null);
	const renameFailure = $derived(form?.intent === 'rename' ? form : null);
</script>

<section class="mx-auto flex min-h-full w-full max-w-3xl flex-col">
	<h1 class="border-b border-border px-4 py-3 text-sm font-semibold text-text-primary">Contacts</h1>

	<!--
		Above the list and outside the empty-state branch on purpose: adding the
		very first contact is exactly the case the empty state describes, so the
		affordance has to be there when there is nothing else on the page.
	-->
	<AddContactForm
		open={data.adding}
		maxNameLength={data.maxNameLength}
		maxEmailLength={data.maxEmailLength}
		errorMessage={addFailure?.message ?? null}
		conflictId={addFailure?.conflictId ?? null}
		submittedName={addFailure?.name ?? null}
		submittedEmail={addFailure?.email ?? null}
	/>

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
					<!--
						`editing` and the failure both come from the server: the open row is
						`?edit=<id>`, and the `fail()` payload is keyed by id so a rejected save
						can only ever annotate — and re-seed — the row it was for. It carries
						the rejected text as well as the message, so the owner gets their input
						back to correct rather than an empty field.
					-->
					<ContactRow
						{contact}
						editing={data.editingId === contact.id}
						maxNameLength={data.maxNameLength}
						errorMessage={renameFailure?.id === contact.id ? renameFailure.message : null}
						submittedName={renameFailure?.id === contact.id ? renameFailure.name : null}
					/>
				</li>
			{/each}
		</ul>
	{/if}
</section>
