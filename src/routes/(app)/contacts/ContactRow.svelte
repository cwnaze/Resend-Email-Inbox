<script lang="ts">
	/**
	 * One contact in the contacts list (US-I01).
	 *
	 * Same flat, divider-based row style as the inbox list (prd-feature-contacts
	 * "Design Considerations"): name in the humanist sans, address and stats in
	 * the monospace face per prd-ui-ux FR-2 (all metadata is mono).
	 *
	 * Not a link: there is no contact detail route, and US-I02 turns this row
	 * into an edit affordance instead.
	 */
	import { relativeTime } from '$lib/inbox/format';

	let {
		contact
	}: {
		contact: {
			displayName: string;
			email: string;
			messageCount: number;
			lastContactedAt: Date | null;
		};
	} = $props();

	// A contact whose name is unknown falls back to its address as the heading
	// (both here and in the sort), in which case repeating it underneath is
	// noise.
	const showsEmailSeparately = $derived(contact.displayName !== contact.email);

	// Recomputed on render rather than ticked on a timer, same as `ThreadRow`.
	const lastContacted = $derived(
		contact.lastContactedAt ? relativeTime(contact.lastContactedAt) : null
	);
</script>

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
</div>
