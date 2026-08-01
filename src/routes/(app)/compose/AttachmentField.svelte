<script lang="ts">
	/**
	 * Picking files to attach to a composed message (US-H05).
	 *
	 * **The bytes go straight from this component to R2**, over a presigned PUT
	 * minted by `POST /compose/uploads`, and the form submits only the resulting
	 * object keys. Not an optimization: the app runs on Vercel, whose functions cap
	 * a request body around 4.5 MB, so a 25 MB file posted through the form action
	 * could never arrive. It also means the size limit is enforced at pick time,
	 * where the owner can still do something about it, rather than after a long
	 * upload.
	 *
	 * The list is this component's state and the hidden `attachments` field is
	 * rendered from it, so what submits is exactly what is on screen — the same
	 * "one visible source of truth" rule `RecipientField.svelte` follows by keeping
	 * the addresses in the input the owner can see.
	 *
	 * A file still uploading is shown as such and keeps the page's Send button
	 * unavailable, because only a file that already has an R2 key is in the hidden
	 * field — a send that raced an upload would go out without it and say nothing.
	 */
	import { resolve } from '$app/paths';
	import {
		MAX_ATTACHMENT_TOTAL_BYTES,
		type AttachmentItem,
		type PendingAttachment
	} from '$lib/compose/attachments';
	import { formatFileSize } from '$lib/inbox/format';

	let {
		items = $bindable(),
		/**
		 * Bytes already committed to this message by files this component does not
		 * own — a forward's carried attachments (US-H04). The limit is per message,
		 * so they count against it here even though they cannot be removed here.
		 */
		otherBytes = 0
	}: { items: AttachmentItem[]; otherBytes?: number } = $props();

	const uploadsUrl = resolve('/(app)/compose/uploads');

	/** A whole-list problem (a file too large to fit), as opposed to one failed upload. */
	let listError = $state<string | undefined>(undefined);
	let dragging = $state(false);
	let input = $state<HTMLInputElement | null>(null);

	const usedBytes = $derived(otherBytes + items.reduce((sum, item) => sum + item.sizeBytes, 0));

	/**
	 * Settles the row for `id` — by **id, looked up in `items`**, never through the
	 * object that was pushed.
	 *
	 * `items` is a deeply-proxied `$state` array, so `items.push(obj)` stores a
	 * proxy of `obj`; a later `obj.status = 'ready'` writes straight to the target
	 * and never trips the proxy's setter, so nothing re-renders. That is not
	 * theoretical — it is exactly what this component did first, and the symptom
	 * was a finished upload stuck on "uploading…" forever with Send permanently
	 * disabled. Reading the element back out of `items` is what makes the write
	 * reactive.
	 *
	 * A row the owner removed mid-upload is simply gone, and settling it is a
	 * no-op — which is the right answer: Remove is available during an upload on
	 * purpose.
	 */
	function settle(id: string, patch: Partial<AttachmentItem>) {
		const item = items.find((candidate) => candidate.id === id);
		if (item) {
			Object.assign(item, patch);
			return;
		}
		// The row is gone: the owner hit Remove while this upload was in flight, so
		// `remove()` had no key to send a DELETE for and the PUT landed anyway.
		// Sweep it here, where the key finally exists — otherwise the object sits in
		// `outbound/pending/` forever with no send coming to claim or clear it.
		if (patch.key) discard(patch.key);
	}

	/** Fire-and-forget delete of a pending object the draft no longer wants. */
	function discard(key: string) {
		void fetch(uploadsUrl, {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ key })
		}).catch((error) => console.error('attachment discard failed:', error));
	}

	async function upload(id: string, file: File) {
		try {
			const minted = await fetch(uploadsUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					filename: file.name,
					contentType: file.type,
					sizeBytes: file.size
				})
			});
			if (!minted.ok) throw new Error(`mint failed: ${minted.status}`);
			const { key, uploadUrl, contentType } = await minted.json();

			// The content type is part of the signature, so it has to be exactly the
			// one the endpoint approved — not `file.type`, which it may have replaced.
			const put = await fetch(uploadUrl, {
				method: 'PUT',
				headers: { 'content-type': contentType },
				body: file
			});
			if (!put.ok) throw new Error(`upload failed: ${put.status}`);

			settle(id, { key, status: 'ready' });
		} catch (error) {
			console.error('attachment upload failed:', error);
			settle(id, { status: 'failed' });
		}
	}

	function addFiles(files: FileList | null) {
		if (!files || files.length === 0) return;
		listError = undefined;

		for (const file of Array.from(files)) {
			// Checked one file at a time against the running total, so picking four
			// files where the third is the one that overflows still attaches the two
			// that fit rather than refusing the whole selection.
			if (usedBytes + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
				listError = `${file.name} doesn’t fit — attachments are limited to ${formatFileSize(MAX_ATTACHMENT_TOTAL_BYTES)} in total.`;
				continue;
			}
			const item: AttachmentItem = {
				id: crypto.randomUUID(),
				filename: file.name,
				sizeBytes: file.size,
				key: null,
				status: 'uploading'
			};
			items.push(item);
			void upload(item.id, file);
		}

		// So picking the same file twice in a row still fires `onchange`.
		if (input) input.value = '';
	}

	function remove(item: AttachmentItem) {
		items = items.filter((candidate) => candidate.id !== item.id);
		listError = undefined;
		// The object is already in the bucket and no send is coming for it. Fire and
		// forget: the file is gone from the draft either way, and the endpoint only
		// accepts `outbound/pending/` keys, so the worst case is one orphan under the
		// prefix that exists to hold unclaimed uploads.
		//
		// A row removed *mid-upload* has no key yet — `settle()` sweeps that one when
		// the PUT finally lands and finds its row gone.
		if (item.key) discard(item.key);
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		addFiles(event.dataTransfer?.files ?? null);
	}
</script>

<div class="flex flex-col gap-1">
	<span class="font-mono text-xs text-text-muted">Attachments</span>

	<!--
		A drop target that is also a plain button, not a bare drop zone: drag and
		drop is unavailable to a keyboard and to most touch input, so the picker has
		to be reachable without it. The `<input type="file">` is visually hidden and
		driven by that button; it carries no `name`, so it submits nothing — the
		hidden `attachments` field at the bottom is what travels with the form.
	-->
	<div
		role="group"
		aria-label="Attach files"
		ondragover={(event) => {
			event.preventDefault();
			dragging = true;
		}}
		ondragleave={() => (dragging = false)}
		ondrop={onDrop}
		class="flex items-center gap-3 rounded border border-dashed px-2.5 py-3 transition-colors duration-fast ease-standard {dragging
			? 'border-accent bg-accent/10'
			: 'border-border bg-surface'}"
	>
		<button
			id="attach-button"
			type="button"
			onclick={() => input?.click()}
			class="rounded border border-border bg-background px-2.5 py-1 font-mono text-xs text-text-muted transition-colors duration-fast ease-standard hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:outline-none"
		>
			+ Attach
		</button>
		<span class="font-sans text-sm text-text-muted">
			or drop files here — up to {formatFileSize(MAX_ATTACHMENT_TOTAL_BYTES)} in total
		</span>
		<input
			bind:this={input}
			id="attach-input"
			type="file"
			multiple
			onchange={(event) => addFiles(event.currentTarget.files)}
			class="sr-only"
		/>
	</div>

	{#if items.length > 0}
		<ul class="mt-1 flex flex-col gap-1">
			{#each items as item (item.id)}
				<li class="flex items-baseline gap-2 font-mono text-xs text-text-primary">
					<span class="min-w-0 break-all">{item.filename}</span>
					<span class="shrink-0 text-text-muted">{formatFileSize(item.sizeBytes)}</span>
					{#if item.status === 'uploading'}
						<span class="shrink-0 text-text-muted">uploading…</span>
					{:else if item.status === 'failed'}
						<span class="shrink-0 text-danger">upload failed</span>
					{/if}
					<!--
						`text-danger` per the compose design note: a remove affordance is the
						one destructive control on this screen. It is available while an
						upload is still running too — a file picked by mistake should not
						have to finish uploading before it can be taken back.
					-->
					<button
						type="button"
						onclick={() => remove(item)}
						aria-label="Remove {item.filename}"
						class="ml-auto shrink-0 rounded border border-transparent px-1 text-danger transition-colors duration-fast ease-standard hover:border-danger focus-visible:border-danger focus-visible:outline-none"
					>
						Remove
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if listError}
		<p role="alert" class="font-sans text-sm text-danger">{listError}</p>
	{/if}

	<!--
		What actually submits: the keys of the files already in R2, rendered from the
		same list the owner is looking at.

		A file that is still uploading, or whose upload failed, has no key and so is
		absent from this field — which is why the page's Send button is gated on
		`unsettledAttachments(items)` covering *both* states, not just the in-flight
		one. Leaving a failed row out of that gate would let the owner send a message
		listing a file it does not carry: the same "says see attached and doesn't"
		failure the server treats as fatal before a send, arrived at from the client
		side instead. The way past a failed upload is Remove, which is on every row.
	-->
	<input
		type="hidden"
		name="attachments"
		value={JSON.stringify(
			items
				.filter((item): item is AttachmentItem & { key: string } => item.key !== null)
				.map((item): PendingAttachment => ({
					key: item.key,
					filename: item.filename,
					sizeBytes: item.sizeBytes
				}))
		)}
	/>
</div>
