<script lang="ts">
	/**
	 * One message's attachments (US-G03), below its body.
	 *
	 * Filename + size only — no thumbnail, no icon per type. Each row is a plain
	 * `<a href>` at the download endpoint, which presigns an R2 URL per click and
	 * 302s to it, so this component holds no URL that can expire and needs no
	 * JavaScript to work.
	 *
	 * Metadata face (monospace) per the thread view's design conventions: a
	 * filename and a byte count are metadata, not prose.
	 */
	import { resolve } from '$app/paths';

	interface Props {
		/**
		 * The thread the message belongs to. Part of the download route, so it has to
		 * reach the component: `resolve` needs every parameter of the route id, and
		 * `svelte/no-navigation-without-resolve` rejects an href that arrives
		 * pre-built from the load, so the URL cannot be assembled server-side.
		 */
		threadId: string;
		attachments: { id: string; filename: string; size: string }[];
	}

	const { threadId, attachments }: Props = $props();
</script>

<!--
	`data-sveltekit-reload` is load-bearing, not decorative. The href points at a
	`+server.ts` route inside the app, and without this the client-side router
	would try to treat a click as an SPA navigation to a route that has no page
	component. This forces a real browser navigation, which is what lets the
	browser follow the 302 to R2 and honour the `Content-Disposition` it answers
	with.
-->
<section
	class="mt-4 max-w-[72ch] border-t border-border pt-3"
	data-sveltekit-reload
	aria-label="Attachments"
>
	<h4 class="font-mono text-xs text-text-muted">
		{attachments.length}
		{attachments.length === 1 ? 'attachment' : 'attachments'}
	</h4>

	<ul class="mt-2 flex flex-col gap-1">
		{#each attachments as attachment (attachment.id)}
			<li>
				<a
					href={resolve('/(app)/inbox/[threadId]/attachments/[attachmentId]', {
						threadId,
						attachmentId: attachment.id
					})}
					class="group flex items-baseline gap-2 rounded-sm font-mono text-xs text-text-primary transition-colors duration-fast ease-standard hover:text-accent focus-visible:text-accent focus-visible:outline-none"
				>
					<!--
						`break-all` because a filename is not prose and can be one long
						unbroken token; `min-w-0` so it can actually shrink inside the flex row
						rather than forcing horizontal scroll.
					-->
					<span
						class="min-w-0 break-all underline decoration-border underline-offset-2 group-hover:decoration-accent"
					>
						{attachment.filename}
					</span>
					<!--
						Inside the link on purpose: the size becomes part of the accessible
						name ("invoice.pdf, 24.1 KB"), which is more useful for a
						screen-reader user deciding whether to download than a bare filename.
						`shrink-0` keeps it on one line beside a long name.
					-->
					<span class="shrink-0 text-text-muted">{attachment.size}</span>
				</a>
			</li>
		{/each}
	</ul>
</section>
