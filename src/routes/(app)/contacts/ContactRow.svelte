<script lang="ts">
	/**
	 * One contact in the contacts list (US-I01), which US-I02 turns into either a
	 * read row with an Edit link or the rename form itself.
	 *
	 * Same flat, divider-based row style as the inbox list (prd-feature-contacts
	 * "Design Considerations"): name in the humanist sans, address and stats in
	 * the monospace face per prd-ui-ux FR-2 (all metadata is mono).
	 *
	 * Editing is a *server-rendered* mode, not local component state — the parent
	 * decides from `?edit=<id>` and passes `editing` down. That is what makes the
	 * form work with JavaScript off and survive a `fail()` re-render; see the
	 * load's comment.
	 */
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import { relativeTime } from '$lib/inbox/format';

	let {
		contact,
		editing,
		maxNameLength,
		errorMessage,
		submittedName
	}: {
		contact: {
			id: string;
			displayName: string;
			name: string | null;
			email: string;
			messageCount: number;
			lastContactedAt: Date | null;
		};
		/** Render the rename form instead of the read row. */
		editing: boolean;
		maxNameLength: number;
		/** Server-side validation message for this row, if the last save failed. */
		errorMessage: string | null;
		/** The rejected text from that failed save, so it can be corrected rather than retyped. */
		submittedName: string | null;
	} = $props();

	// A rejected save wins over the stored name — that is the value the owner is
	// being asked to fix. `??`, not `||`: a submitted empty string is a real
	// answer and must not fall back to the stored name.
	const fieldValue = $derived(submittedName ?? contact.name ?? '');

	// A contact whose name is unknown falls back to its address as the heading
	// (both here and in the sort), in which case repeating it underneath is
	// noise.
	const showsEmailSeparately = $derived(contact.displayName !== contact.email);

	// Recomputed on render rather than ticked on a timer, same as `ThreadRow`.
	const lastContacted = $derived(
		contact.lastContactedAt ? relativeTime(contact.lastContactedAt) : null
	);

	// `resolve()` has no query-string form, so the path is resolved and then
	// decorated — same shape as `ThreadMessage`'s `replyHref`, and the id is
	// percent-encoded on the way in.
	const contactsHref = resolve('/(app)/contacts');
	const editHref = $derived(
		`${contactsHref}?edit=${encodeURIComponent(contact.id)}` as ResolvedPathname
	);

	// The action carries `edit` as well: a form action's query replaces the
	// page's, so without it a `fail()` would re-render with the form closed.
	const saveAction = $derived(`?/rename&edit=${encodeURIComponent(contact.id)}`);
</script>

{#if editing}
	<form
		method="POST"
		action={saveAction}
		class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3"
	>
		<input type="hidden" name="id" value={contact.id} />

		<div class="min-w-0 flex-1">
			<label class="block text-xs text-text-muted" for={`contact-name-${contact.id}`}>
				Name for <span class="font-mono">{contact.email}</span>
			</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				id={`contact-name-${contact.id}`}
				name="name"
				type="text"
				autofocus
				autocomplete="off"
				maxlength={maxNameLength}
				value={fieldValue}
				placeholder="Leave blank to show the address"
				class="mt-1 w-full rounded-sm border border-border bg-surface px-2 py-1 text-sm text-text-primary outline-none focus-visible:border-accent"
			/>
			{#if errorMessage}
				<p role="alert" class="mt-1 font-sans text-xs text-danger">{errorMessage}</p>
			{/if}
		</div>

		<div class="flex shrink-0 items-center gap-2">
			<button
				type="submit"
				class="rounded-sm border border-accent px-2 py-1 font-mono text-xs text-accent transition-colors duration-fast ease-standard hover:bg-accent hover:text-background"
			>
				Save
			</button>
			<a
				href={contactsHref}
				class="rounded-sm px-2 py-1 font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-text-primary"
			>
				Cancel
			</a>
		</div>
	</form>
{:else}
	<div class="flex items-baseline gap-3 border-b border-border px-4 py-3">
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm font-medium text-text-primary">{contact.displayName}</p>
			{#if showsEmailSeparately}
				<p class="mt-0.5 truncate font-mono text-xs text-text-muted">{contact.email}</p>
			{/if}
		</div>

		<div class="shrink-0 text-right font-mono text-xs text-text-muted">
			<p>
				{contact.messageCount}
				{contact.messageCount === 1 ? 'message' : 'messages'}
			</p>
			{#if contact.lastContactedAt && lastContacted}
				<p class="mt-0.5">
					<time datetime={contact.lastContactedAt.toISOString()}>{lastContacted}</time>
				</p>
			{/if}
		</div>

		<a
			href={editHref}
			aria-label={`Edit ${contact.displayName}`}
			class="shrink-0 rounded-sm px-2 py-1 font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-accent focus-visible:text-accent focus-visible:outline-1 focus-visible:outline-accent"
		>
			Edit
		</a>
	</div>
{/if}
