<script lang="ts">
	/**
	 * A recipient field (To or Cc) with contact autocomplete (US-H01).
	 *
	 * One plain `<input name="to">` holding a comma-separated list, **not** a
	 * chip/token widget over a hidden input. Two reasons: the field still works
	 * with no JavaScript (the suggestion list is the only scripted part, and it is
	 * purely additive), and the value the form submits is the value the owner can
	 * see and edit — a token widget's hidden mirror is a second source of truth
	 * that can disagree with the visible chips.
	 *
	 * The suggestion list is a hand-rolled ARIA combobox rather than a
	 * `<datalist>`: `<datalist>` renders browser-native chrome that can't be
	 * themed to the Dusk Terminal surface, matches on the *whole* field value
	 * (so it stops suggesting the moment the field holds `a@b.com, ` and a second
	 * fragment), and is not reliably driveable for the browser verification this
	 * story is graded on.
	 *
	 * Address text is monospace per the design system's "metadata is monospace"
	 * rule (`docs/notes/ui.md`).
	 */
	import {
		activeEntry,
		parseAddressList,
		replaceActiveEntry,
		suggestContacts,
		type ContactSuggestion
	} from '$lib/compose/addresses';

	interface Props {
		/** Form field name, which is also the id stem for the label/listbox wiring. */
		name: 'to' | 'cc';
		label: string;
		/** Bound to the parent so it can validate the whole draft in one place. */
		value: string;
		contacts: ContactSuggestion[];
		/** Validation message for this field, shown only once it should be. */
		error?: string;
		required?: boolean;
	}

	let {
		name,
		label,
		value = $bindable(),
		contacts,
		error = undefined,
		required = false
	}: Props = $props();

	let input: HTMLInputElement | null = null;
	// The caret is mirrored into state because the suggestion list depends on it:
	// which entry is "being typed" is a function of the caret, not of the value,
	// so clicking into an earlier address has to re-target the suggestions.
	let caret = $state(0);
	let open = $state(false);
	let activeIndex = $state(-1);

	const entry = $derived(activeEntry(value, caret));
	// The addresses already committed *elsewhere* in the field — the entry being
	// typed is cut out first, so finishing an address by hand doesn't make its own
	// contact vanish from the list mid-keystroke.
	const otherAddresses = $derived(
		parseAddressList(value.slice(0, entry.start) + ',' + value.slice(entry.end)).addresses
	);
	const suggestions = $derived(open ? suggestContacts(contacts, entry.text, otherAddresses) : []);
	const listboxId = $derived(`${name}-suggestions`);
	// Only the *highlighted* option is announced as active; -1 (nothing chosen
	// yet, so Enter submits the form rather than picking a suggestion) must not
	// point `aria-activedescendant` at option -1.
	const activeOptionId = $derived(
		activeIndex >= 0 && activeIndex < suggestions.length ? `${listboxId}-${activeIndex}` : undefined
	);

	function syncCaret() {
		caret = input?.selectionStart ?? value.length;
	}

	function onInput() {
		syncCaret();
		open = true;
		activeIndex = -1;
	}

	function choose(contact: ContactSuggestion) {
		const next = replaceActiveEntry(value, caret, contact.email);
		value = next.value;
		open = false;
		activeIndex = -1;
		// The caret has to be placed after Svelte has written the new value to the
		// DOM, or the browser puts it wherever the old value left it.
		const element = input;
		if (element) {
			requestAnimationFrame(() => {
				element.focus();
				element.setSelectionRange(next.caret, next.caret);
				caret = next.caret;
			});
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			// Doesn't clear the field — Escape closes the popup, and a keystroke that
			// discarded typed addresses would be a data-loss trap.
			open = false;
			activeIndex = -1;
			return;
		}

		if (suggestions.length === 0) return;

		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			const count = suggestions.length;
			activeIndex = (activeIndex + step + count) % count;
			return;
		}

		if ((event.key === 'Enter' || event.key === 'Tab') && activeIndex >= 0) {
			// Only when a suggestion is highlighted: otherwise Enter must keep its
			// normal submit behaviour and Tab must keep moving focus.
			event.preventDefault();
			choose(suggestions[activeIndex]);
		}
	}
</script>

<div class="flex flex-col gap-1">
	<label for={name} class="font-mono text-xs text-text-muted">
		{label}{#if required}<span aria-hidden="true"> *</span>{/if}
	</label>

	<!-- `relative` so the popup can be absolutely positioned against the input. -->
	<div class="relative">
		<input
			bind:this={input}
			bind:value
			id={name}
			{name}
			{required}
			type="text"
			role="combobox"
			aria-expanded={suggestions.length > 0}
			aria-controls={listboxId}
			aria-autocomplete="list"
			aria-activedescendant={activeOptionId}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={error ? `${name}-error` : undefined}
			autocomplete="off"
			spellcheck="false"
			placeholder="name@example.com, another@example.com"
			oninput={onInput}
			onclick={syncCaret}
			onkeyup={syncCaret}
			onkeydown={onKeydown}
			onfocus={() => {
				syncCaret();
				open = true;
			}}
			onblur={() => {
				// A click on an option fires blur first; the option's `onmousedown`
				// prevents default so focus never actually leaves, but a real blur
				// (Tab away, click elsewhere) must close the popup.
				open = false;
				activeIndex = -1;
			}}
			class="w-full rounded border border-border bg-surface px-2.5 py-1.5 font-mono text-sm text-text-primary transition-colors duration-fast ease-standard placeholder:text-text-muted focus:border-accent focus:outline-none aria-[invalid=true]:border-danger"
		/>

		{#if suggestions.length > 0}
			<ul
				id={listboxId}
				role="listbox"
				aria-label="{label} contact suggestions"
				class="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded border border-border bg-surface py-1 shadow-lg"
			>
				{#each suggestions as contact, index (contact.email)}
					<li
						id="{listboxId}-{index}"
						role="option"
						aria-selected={index === activeIndex}
						class="cursor-pointer px-2.5 py-1.5 {index === activeIndex ? 'bg-background' : ''}"
						onmousedown={(event) => {
							// Keeps focus in the input, so the field doesn't blur-and-close out
							// from under the click that is choosing an option.
							event.preventDefault();
							choose(contact);
						}}
						onmouseenter={() => (activeIndex = index)}
					>
						<span class="block font-mono text-xs text-text-primary">{contact.email}</span>
						{#if contact.name}
							<span class="block text-xs text-text-muted">{contact.name}</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	{#if error}
		<!--
			`role="alert"` on the message text itself, matching `ErrorMessage.svelte`'s
			convention (`docs/notes/ui.md`): the field's own label and value must not
			get swept into the announcement.
		-->
		<p id="{name}-error" role="alert" class="font-mono text-xs text-danger">{error}</p>
	{/if}
</div>
