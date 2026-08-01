<script lang="ts">
	/**
	 * The "add a contact by hand" form (US-I03), rendered at the top of the
	 * contacts list when `?add` is on the URL.
	 *
	 * Server-rendered mode, exactly like `ContactRow`'s edit form: the parent
	 * decides from the URL and passes `open` down, so this works with JavaScript
	 * off, survives a refresh, and stays open across a `fail()`.
	 */
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';

	let {
		open,
		maxNameLength,
		maxEmailLength,
		errorMessage,
		conflictId,
		submittedName,
		submittedEmail
	}: {
		/** Render the form instead of the "Add contact" link. */
		open: boolean;
		maxNameLength: number;
		maxEmailLength: number;
		/** Server-side validation message from the last failed add, if any. */
		errorMessage: string | null;
		/** Id of the contact a duplicate-address rejection collided with, if that was the reason. */
		conflictId: string | null;
		/** The rejected input, echoed back so a typo is corrected rather than retyped. */
		submittedName: string | null;
		submittedEmail: string | null;
	} = $props();

	// `??`, not `||`: a submitted empty string is a real answer (the name is
	// optional, and blanking it is what the owner meant).
	const nameValue = $derived(submittedName ?? '');
	const emailValue = $derived(submittedEmail ?? '');

	// `resolve()` has no query form, so the path is resolved and then decorated
	// — the same shape as `ContactRow`'s `editHref` (see the root CLAUDE.md).
	const contactsHref = resolve('/(app)/contacts');
	const openHref = `${contactsHref}?add` as ResolvedPathname;
	// A duplicate rejection points at the row that already owns the address, by
	// opening *its* edit form — the useful next move when the contact the owner
	// meant to create turns out to exist under a different name.
	const conflictHref = $derived(
		conflictId
			? (`${contactsHref}?edit=${encodeURIComponent(conflictId)}` as ResolvedPathname)
			: null
	);

	// The action carries `add` for the same reason `rename`'s carries `edit`: a
	// form action's query replaces the page's, so a `fail()` would otherwise
	// re-render with this form closed.
	const addAction = '?/add&add=1';
</script>

{#if open}
	<form
		method="POST"
		action={addAction}
		class="flex flex-col gap-3 border-b border-border bg-surface px-4 py-3"
	>
		<div class="flex flex-wrap items-end gap-3">
			<div class="min-w-0 flex-1">
				<label class="block text-xs text-text-muted" for="new-contact-email">Email address</label>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					id="new-contact-email"
					name="email"
					type="email"
					autofocus
					autocomplete="off"
					required
					maxlength={maxEmailLength}
					value={emailValue}
					placeholder="someone@example.com"
					class="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1 font-mono text-sm text-text-primary outline-none focus-visible:border-accent"
				/>
			</div>

			<div class="min-w-0 flex-1">
				<label class="block text-xs text-text-muted" for="new-contact-name">Name (optional)</label>
				<input
					id="new-contact-name"
					name="name"
					type="text"
					autocomplete="off"
					maxlength={maxNameLength}
					value={nameValue}
					placeholder="Leave blank to show the address"
					class="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1 text-sm text-text-primary outline-none focus-visible:border-accent"
				/>
			</div>

			<div class="flex shrink-0 items-center gap-2 pb-1">
				<button
					type="submit"
					class="rounded-sm border border-accent px-2 py-1 font-mono text-xs text-accent transition-colors duration-fast ease-standard hover:bg-accent hover:text-background"
				>
					Add
				</button>
				<a
					href={contactsHref}
					class="rounded-sm px-2 py-1 font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-text-primary"
				>
					Cancel
				</a>
			</div>
		</div>

		{#if errorMessage}
			<p role="alert" class="font-sans text-xs text-danger">
				{errorMessage}
				{#if conflictHref}
					<a href={conflictHref} class="underline decoration-dotted underline-offset-2"
						>Edit that contact</a
					>
				{/if}
			</p>
		{/if}
	</form>
{:else}
	<div class="flex justify-end border-b border-border px-4 py-2">
		<a
			href={openHref}
			class="rounded-sm px-2 py-1 font-mono text-xs text-accent transition-colors duration-fast ease-standard hover:underline focus-visible:outline-1 focus-visible:outline-accent"
		>
			Add contact
		</a>
	</div>
{/if}
