<script lang="ts">
	/**
	 * One message inside a thread (US-G01).
	 *
	 * Per the design system (tasks/prd-feature-thread-view.md § Design
	 * Considerations): all metadata — sender address, recipients, timestamp — in
	 * the monospace face, the body in the humanist sans at a comfortable reading
	 * measure, and a thin 1px divider between messages rather than a card with a
	 * shadow.
	 *
	 * Body rendering (US-G02) is **not** an either/or: the load can send an HTML body
	 * (rendered by `EmailHtmlBody` in a sandboxed iframe), a plain-text body, or
	 * both. Both happens when the HTML has no readable text of its own — a frame
	 * whose content can't be vouched for is shown *with* the text beneath it, so a
	 * message can never become unreachable because a tracking pixel talked the load
	 * into preferring markup that renders blank. Neither happens only when there is
	 * genuinely nothing to show, and then the "no body" line is the honest answer.
	 *
	 * Nothing in this file uses `{@html}` — stored markup is never injected into
	 * *this* document, only into the sandboxed one.
	 */
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import EmailHtmlBody from './EmailHtmlBody.svelte';
	import AttachmentList from './AttachmentList.svelte';

	// Narrower than the load's message shape — `svelte/no-unused-props` (correctly)
	// rejects declaring a field this component doesn't use. `id` is read as of
	// US-G04: it is the delete form's `emailId`.
	interface Props {
		/** Passed straight through to `AttachmentList`, which needs it to build a download href. */
		threadId: string;
		message: {
			id: string;
			sender: string;
			fromEmail: string;
			to: string;
			cc: string;
			receivedAt: Date;
			timestamp: string;
			html: string | null;
			blockedImageCount: number;
			body: string;
			attachments: { id: string; filename: string; size: string }[];
		};
	}

	const { threadId, message }: Props = $props();

	// Only worth a second line when the display name isn't already the address.
	const showAddress = $derived(message.sender !== message.fromEmail);

	// The reply link's href (US-H03). Built here rather than inline because
	// `resolve()` has no query-string form and `svelte/no-navigation-without-resolve`
	// only accepts either a bare `resolve(...)` call or a value already typed as
	// `ResolvedPathname` — the rule's own sanctioned shape for a path that has been
	// resolved and then decorated. The path itself still goes through `resolve`,
	// which is what the repo rule is actually protecting; only the query is
	// appended, and the id is percent-encoded on the way in.
	const replyHref = $derived(
		`${resolve('/(app)/compose')}?replyTo=${encodeURIComponent(message.id)}` as ResolvedPathname
	);
</script>

<article class="border-b border-border px-4 py-5 last:border-b-0 sm:px-6">
	<header class="flex flex-col gap-1">
		<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
			<h3 class="min-w-0 text-sm font-medium text-text-primary">{message.sender}</h3>
			<time
				datetime={message.receivedAt.toISOString()}
				class="shrink-0 font-mono text-xs text-text-muted"
			>
				{message.timestamp}
			</time>
		</div>

		<dl class="flex flex-col gap-0.5 font-mono text-xs text-text-muted">
			{#if showAddress}
				<div class="flex gap-1.5">
					<dt class="shrink-0">from</dt>
					<dd class="min-w-0 break-all">{message.fromEmail}</dd>
				</div>
			{/if}
			{#if message.to}
				<div class="flex gap-1.5">
					<dt class="shrink-0">to</dt>
					<dd class="min-w-0 break-all">{message.to}</dd>
				</div>
			{/if}
			{#if message.cc}
				<div class="flex gap-1.5">
					<dt class="shrink-0">cc</dt>
					<dd class="min-w-0 break-all">{message.cc}</dd>
				</div>
			{/if}
		</dl>
	</header>

	{#if message.html}
		<EmailHtmlBody
			html={message.html}
			blockedImageCount={message.blockedImageCount}
			title={`Message from ${message.sender}`}
		/>
	{/if}

	<!--
		Preformatted so the message's own line breaks survive (`whitespace-pre-wrap`
		also wraps to the reading measure), in the app's sans face rather than the
		monospace `<pre>` default because this is prose. `break-words` stops a long
		unbroken URL from forcing horizontal scroll.
	-->
	{#if message.body && !message.html}
		<pre
			class="mt-3 max-w-[72ch] font-sans text-sm leading-relaxed break-words whitespace-pre-wrap text-text-primary">{message.body}</pre>
	{:else if message.body}
		<!--
			Both bodies are present, which means the HTML has no readable text of its
			own and the frame may be showing little or nothing. Collapsed and labelled
			rather than concatenated: dumped straight under the frame it reads as the
			same message twice, with nothing to tell a reader — or a screen reader —
			which is which. Closed by default because the frame is usually the better
			rendering; open is one click away when it isn't.
		-->
		<details class="mt-3 max-w-[72ch]">
			<summary
				class="cursor-pointer font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-accent focus-visible:text-accent focus-visible:outline-none"
			>
				Plain-text version
			</summary>
			<pre
				class="mt-2 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap text-text-primary">{message.body}</pre>
		</details>
	{/if}

	{#if !message.html && !message.body}
		<p class="mt-3 font-sans text-sm text-text-muted italic">This message has no body.</p>
	{/if}

	<!--
		Below the body, per the story: an attachment is what the message came *with*,
		not part of what it says. Rendered only when there is at least one — a
		"0 attachments" heading on every message would be noise, and most messages
		have none. A message whose attachments all failed to upload at ingest (that
		is best-effort, see `inbound/attachments.ts`) has no rows here and correctly
		shows nothing.
	-->
	{#if message.attachments.length > 0}
		<AttachmentList {threadId} attachments={message.attachments} />
	{/if}

	<!--
		Delete (US-G04). A plain `method="POST"` form with no `use:enhance`: the
		action re-runs the page load, so the message leaves the view either way, and
		a delete that keeps working with JavaScript off is worth more here than
		avoiding the reload. It is the message *id* that is posted, not its index —
		an index would be silently wrong the moment two tabs disagree about the
		thread. The action is deliberately below the body and the attachments: it acts
		on the message above it, and it must not sit where a reader aiming for a link
		can hit it.

		`aria-label` names the message the button acts on, because a thread renders one
		"Delete" per message and "Delete, button" ×3 is not a choice a screen-reader
		user can make.
	-->
	<footer class="mt-4 flex justify-end gap-1">
		<!--
			Reply (US-H03). A plain GET link, not a form: opening the compose screen
			pre-filled changes nothing, so it must be safe to prefetch, bookmark and
			middle-click. The *only* thing it carries is this message's id — compose
			re-reads the recipient, subject, quoted text and thread from the row.

			`aria-label` names the message for the same reason Delete's does: a thread
			renders one of each per message.
		-->
		<a
			href={replyHref}
			aria-label={`Reply to message from ${message.sender}`}
			class="rounded-sm px-2 py-1 font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-accent focus-visible:text-accent focus-visible:outline-1 focus-visible:outline-accent"
		>
			Reply
		</a>
		<form method="POST" action="?/deleteMessage">
			<input type="hidden" name="emailId" value={message.id} />
			<button
				type="submit"
				aria-label={`Delete message from ${message.sender}`}
				class="rounded-sm px-2 py-1 font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-danger focus-visible:text-danger focus-visible:outline-1 focus-visible:outline-danger"
			>
				Delete
			</button>
		</form>
	</footer>
</article>
