<script lang="ts">
	/**
	 * The compose screen (US-H01).
	 *
	 * To / Cc (collapsible) / Subject / plain-text body, with the Send button
	 * gated on the same `validateComposeDraft` the action re-checks server-side.
	 *
	 * Plain text, not a rich-text editor. The criterion allows an editor "if plain
	 * text always works", and a `<textarea>` is the version where plain text
	 * cannot stop working: no contenteditable, no paste sanitisation, nothing to
	 * serialise, and the body that reaches the send call is exactly the characters
	 * that were typed.
	 *
	 * Submitting a valid draft sends it (US-H02). The three outcomes the action can
	 * return are rendered at the bottom of the form: sent (with a link to the
	 * thread it landed in), sent-but-unrecorded, and not-sent — the last being the
	 * only one that keeps the draft in the fields for a retry.
	 */
	import { untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { resolve } from '$app/paths';
	import RecipientField from './RecipientField.svelte';
	import AttachmentField from './AttachmentField.svelte';
	import ErrorMessage from '$lib/components/ErrorMessage.svelte';
	import { validateComposeDraft } from '$lib/compose/addresses';
	import { unsettledAttachments, type AttachmentItem } from '$lib/compose/attachments';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Seeded from the action's echoed draft so a rejected submit re-renders what
	// was typed instead of an empty form (US-H02 FR-4, built in from the start).
	//
	// `untrack` because this is a deliberate one-time seed of editable state from
	// a prop, not a binding: once the owner is typing, the field is the source of
	// truth and a later `form` update must not overwrite it. The form is a plain
	// (non-`enhance`d) POST, so a result arrives with a fresh page render and
	// therefore a fresh mount — this reads the new draft every time it matters.
	// A *sent* message is deliberately not seeded back: leaving the fields full
	// after a successful send hands the owner a loaded form whose only obvious
	// gesture is Send again. Failure keeps the draft (that is the point of FR-4);
	// success clears it.
	//
	// A reply (US-H03) or a forward (US-H04) seeds from `data.context.draft`
	// instead — but only when the action has nothing to say. The precedence
	// matters in both directions: a rejected submit must re-render what was
	// *typed* (an echoed draft outranks the pre-fill, or editing a reply and
	// getting it refused would silently restore the original recipient), and a
	// successful send must clear the fields even though `?replyTo=`/`?forwardOf=`
	// is still in the URL and the load is still handing back a pre-fill (or a sent
	// reply leaves a fully loaded form whose only obvious gesture is to send it
	// again).
	const seed = untrack(() => (form ? (form.sent ? undefined : form.draft) : data.context?.draft));
	let to = $state(seed?.to ?? '');
	let cc = $state(seed?.cc ?? '');
	let subject = $state(seed?.subject ?? '');
	let body = $state(seed?.body ?? '');

	// The picked files (US-H05), seeded the same way and for the same reason the
	// draft is: the objects are already in R2 and the form is a plain POST, so a
	// refused send that dropped this list would leave the owner re-picking files
	// that are sitting in the bucket. Only ready (keyed) items can survive a round
	// trip — a half-finished upload has no key to come back as.
	//
	// A *forward*'s carried attachments are deliberately not in here: they are
	// looked up server-side from `?forwardOf=` at send time, so they stay the
	// read-only list further down. They still count against the size limit, which
	// is why their bytes are handed to the picker as `otherBytes`.
	let attachments = $state<AttachmentItem[]>(
		untrack(() =>
			form?.sent
				? []
				: (form?.attachments ?? []).map((attachment) => ({
						id: crypto.randomUUID(),
						filename: attachment.filename,
						sizeBytes: attachment.sizeBytes,
						key: attachment.key,
						status: 'ready' as const
					}))
		)
	);

	// Both unfinished states, not just the in-flight one: a *failed* upload has no
	// key either, so sending past one produces a message that lists a file it does
	// not carry. See `unsettledAttachments`.
	const unsettled = $derived(unsettledAttachments(attachments));
	const uploading = $derived(unsettled.some((attachment) => attachment.status === 'uploading'));

	/** What a forward already commits to the per-message size limit (US-H04). */
	const forwardedBytes = $derived(
		(data.context?.attachments ?? []).reduce((sum, attachment) => sum + attachment.sizeBytes, 0)
	);

	// Cc starts collapsed (it is the exception, not the rule) but opens itself if
	// a returned draft has one, so a rejected submit can't hide typed addresses
	// behind a closed toggle.
	let ccOpen = $state((seed?.cc ?? '') !== '');

	// Which fields have been interacted with. Validation messages are gated on
	// this so an untouched form doesn't open covered in complaints about text the
	// owner hasn't had a chance to type; the *button* is gated on validity alone.
	let touched = $state({ to: false, cc: false, content: false });

	const validation = $derived(validateComposeDraft({ to, cc, subject, body }));

	// A returned 400 means the server rejected it, so its messages show
	// unconditionally — that submit *is* the interaction.
	const submitted = $derived(form?.errors !== undefined);

	// A plain function, deliberately not a `$derived` closure: `$derived` tracks
	// what its expression reads *when it runs*, and a returned closure reads
	// nothing at creation time, so the memo would never invalidate. Called from
	// the template, this tracks `validation`/`touched` at render time instead.
	function showError(field: 'to' | 'cc' | 'content'): string | undefined {
		return submitted || touched[field] ? validation.errors[field] : undefined;
	}

	/** What this screen is: a new message, a reply (US-H03) or a forward (US-H04). */
	const heading = $derived(
		data.context === null ? 'New message' : data.context.mode === 'reply' ? 'Reply' : 'Forward'
	);

	/**
	 * Where the form POSTs — `?/send`, plus the source id when there is one.
	 *
	 * The parameter rides in the **action URL**, not in a hidden input, because a
	 * form action's query *replaces* the page's: posting to a bare `?/send` lands
	 * on `/compose?/send` with no `replyTo`, so the page that renders a rejected
	 * send would re-render as an ordinary new message — same fields, but the next
	 * Send would start a new thread instead of continuing the conversation, and
	 * nothing on screen would say so. A forward has *more* riding on this than a
	 * reply: its attachments are looked up from that id at send time, so losing it
	 * across a rejected submit would silently drop the files.
	 */
	const sendAction = $derived(
		data.context === null
			? '?/send'
			: data.context.mode === 'reply'
				? `?/send&replyTo=${encodeURIComponent(data.context.emailId)}`
				: `?/send&forwardOf=${encodeURIComponent(data.context.emailId)}`
	);

	/**
	 * Marks the *edited* field touched, not the whole form.
	 *
	 * One delegated handler rather than one per control (and rather than a
	 * callback prop threaded into `RecipientField`), keyed off the submitted field
	 * name the inputs already carry. Marking everything touched on any keystroke
	 * is what made typing the first character of an address pop up a complaint
	 * about the missing subject.
	 */
	function onFormInput(event: Event) {
		const name = (event.target as HTMLElement & { name?: string }).name;
		if (name === 'to' || name === 'cc') touched[name] = true;
		else touched.content = true;
	}
</script>

<svelte:head>
	<title>{data.context === null ? 'Compose' : heading} — dusk inbox</title>
</svelte:head>

<section class="mx-auto flex w-full max-w-3xl flex-col">
	<header class="border-b border-border px-4 py-4 sm:px-6">
		<!-- A reply or forward goes back where it was started from, not to the list. -->
		{#if data.context}
			<a
				href={resolve('/(app)/inbox/[threadId]', { threadId: data.context.threadId })}
				class="font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-accent"
			>
				← Thread
			</a>
		{:else}
			<a
				href={resolve('/(app)/inbox')}
				class="font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-accent"
			>
				← Inbox
			</a>
		{/if}
		<h1 class="mt-2 text-base font-semibold text-text-primary">{heading}</h1>
	</header>

	<!--
		A real `method="POST"` form at the action, not a JS-only handler: the
		disabled button is a convenience for a browser running our code, and
		`validateComposeDraft` running again in the action is what actually enforces
		the rule (see the button's own comment for how no-JS keeps working).
	-->
	<form
		id="compose-form"
		method="POST"
		action={sendAction}
		class="flex flex-col gap-4 px-4 py-4 sm:px-6"
		novalidate
		oninput={onFormInput}
	>
		<RecipientField
			name="to"
			label="To"
			bind:value={to}
			contacts={data.contacts}
			error={showError('to')}
			required
		/>

		{#if ccOpen}
			<RecipientField
				name="cc"
				label="Cc"
				bind:value={cc}
				contacts={data.contacts}
				error={showError('cc')}
			/>
		{:else}
			<!--
				When collapsed the Cc input is not rendered at all, so the form submits no
				`cc` field — the action reads a missing field as `''`, which is the same
				thing an empty one means. Nothing hidden holds a stale value.
			-->
			<div>
				<button
					id="cc-toggle"
					type="button"
					onclick={() => (ccOpen = true)}
					class="rounded border border-border bg-surface px-2.5 py-1 font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:outline-none"
					aria-expanded="false"
				>
					+ Cc
				</button>
			</div>
		{/if}

		<div class="flex flex-col gap-1">
			<label for="subject" class="font-mono text-xs text-text-muted">Subject</label>
			<input
				id="subject"
				name="subject"
				type="text"
				bind:value={subject}
				autocomplete="off"
				class="w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm text-text-primary transition-colors duration-fast ease-standard placeholder:text-text-muted focus:border-accent focus:outline-none"
			/>
		</div>

		<div class="flex flex-col gap-1">
			<label for="body" class="font-mono text-xs text-text-muted">Message</label>
			<!-- Sans, not mono: the body is prose, and only metadata is monospace here. -->
			<textarea
				id="body"
				name="body"
				bind:value={body}
				rows="14"
				class="w-full resize-y rounded border border-border bg-surface px-2.5 py-2 text-sm leading-relaxed text-text-primary transition-colors duration-fast ease-standard placeholder:text-text-muted focus:border-accent focus:outline-none"
			></textarea>
		</div>

		<!--
			The files a forward is carrying (US-H04). Read-only, and there is nothing
			to remove: they are the original message's attachments, looked up
			server-side from `?forwardOf=` at send time, so a control here could only
			lie about what will be sent. It is still shown, because "the attachments
			come too" is the one thing about Forward a sender would otherwise have to
			take on faith. US-H05 adds the picker, and with it the remove affordance.
		-->
		{#if data.context && data.context.attachments.length > 0}
			<div class="flex flex-col gap-1">
				<h2 class="font-mono text-xs text-text-muted">
					Forwarded {data.context.attachments.length === 1 ? 'attachment' : 'attachments'}
				</h2>
				<ul class="flex flex-col gap-1">
					{#each data.context.attachments as attachment (attachment.id)}
						<li class="flex items-baseline gap-2 font-mono text-xs text-text-primary">
							<span class="min-w-0 break-all">{attachment.filename}</span>
							<span class="shrink-0 text-text-muted">{attachment.size}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<!--
			The picker (US-H05). It sits below the forwarded list so the two read in
			the order they will be sent: what the message already carries, then what
			the owner is adding. `otherBytes` is how the forward's files count against
			the same per-message limit even though this component cannot remove them.
		-->
		<AttachmentField bind:items={attachments} otherBytes={forwardedBytes} />

		{#if showError('content')}
			<p role="alert" class="font-sans text-sm text-danger">{validation.errors.content}</p>
		{/if}

		<div class="flex items-center gap-3 border-t border-border pt-4">
			<!--
				`disabled` only in the browser (`browser && !valid`). Server-rendered,
				the draft is empty and therefore invalid, so an unconditional `disabled`
				ships a button that a browser with no JavaScript can never re-enable — the
				action, and the server-side re-validation that is the real enforcement,
				would be unreachable. With this, no-JS submits and gets the action's own
				validation messages back; with JS the button reports itself unavailable
				rather than accepting a click it would only refuse.
			-->
			<!--
				Also unavailable while a file is still uploading (US-H05): the hidden
				`attachments` field only carries files that already have an R2 key, so a
				send that raced an upload — or that ignored one which failed — would go
				out without the file while the screen still lists it, and nothing would
				ever say so. Still inside the `browser &&` guard: with no JavaScript
				there is no picker and so nothing unsettled to wait for.
			-->
			<button
				type="submit"
				disabled={browser && (!validation.valid || unsettled.length > 0)}
				class="rounded border border-accent bg-accent/15 px-3 py-1.5 font-mono text-sm text-accent transition-colors duration-fast ease-standard hover:bg-accent/25 focus-visible:border-text-primary focus-visible:outline-none disabled:cursor-not-allowed disabled:border-border disabled:bg-surface disabled:text-text-muted"
			>
				Send
			</button>

			{#if !validation.valid}
				<p class="font-sans text-sm text-text-muted">Needs a recipient and a subject or message.</p>
			{:else if uploading}
				<p class="font-sans text-sm text-text-muted">
					Waiting for attachments to finish uploading…
				</p>
			{:else if unsettled.length > 0}
				<!--
					Nothing is in flight, so what is left is a failed upload. Say so where
					the Send button is, not only in the list: the button being unavailable
					is the thing the owner is looking at, and "remove it" is the way out.
				-->
				<p class="font-sans text-sm text-text-muted">
					Remove the {unsettled.length === 1 ? 'attachment that' : 'attachments that'} failed to upload.
				</p>
			{/if}
		</div>

		{#if form?.sent}
			<!--
				A delivered message is reported as delivered even when the `emails` row
				failed to write: the warning says what is missing, but nothing here may
				read as "not sent" or the owner sends the same mail twice.
			-->
			<p role="status" class="font-sans text-sm text-text-muted">
				Sent.
				{#if form.threadId}
					<a
						href={resolve('/(app)/inbox/[threadId]', { threadId: form.threadId })}
						class="text-accent underline decoration-dotted underline-offset-2">View the thread</a
					>.
				{/if}
				<!--
					Shown alongside the link, not instead of it: US-H04's attachment copy
					can fail while the `emails` row itself stored fine, so a warning and a
					thread to link to are no longer mutually exclusive.
				-->
				{#if form.warning}
					{form.warning}
				{/if}
			</p>
		{/if}
		{#if form?.error}
			<ErrorMessage message={form.error} />
		{/if}
	</form>
</section>
