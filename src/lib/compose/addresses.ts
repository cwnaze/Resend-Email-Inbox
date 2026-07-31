// Recipient-list parsing, validation and contact suggestion for the compose
// screen (US-H01, tasks/prd-feature-compose.md).
//
// Pure by design — no env, no db, no DOM — for the same reason as
// `lib/inbox/format.ts`: the browser gates the Send button with these functions
// and the server re-checks the submitted form with the *same* ones, so "what
// counts as a valid recipient list" has exactly one definition. A standalone
// `tsx` script can assert against it too.
//
// Address *syntax* is deliberately not RFC 5322-complete. A full parser accepts
// forms no mail UI can usefully round-trip (comments, quoted local parts,
// group syntax) and this field's job is to catch the typo the owner just made
// before a send burns a Resend call. The rule below is the conservative subset
// every real recipient address falls into.

/** How many suggestions the autocomplete offers at once. */
export const MAX_CONTACT_SUGGESTIONS = 6;

/**
 * The offsets of the `,`/`;` characters that actually separate entries.
 *
 * Both `,` and `;` separate: a pasted list from another mail client can use
 * either. But a separator **inside a quoted display name or inside angle
 * brackets does not separate** — `"Doe, Jane" <jane@x.com>` is the single most
 * common shape a copy-paste out of another mail client produces, and splitting
 * it on its comma left `"Doe` behind as a permanently invalid address that
 * disabled Send with no way to fix it but retyping.
 *
 * One scan shared by the splitter and by the caret logic, so "where does this
 * entry end" has one answer everywhere.
 */
function separatorIndices(value: string): number[] {
	const indices: number[] = [];
	let quoted = false;
	let angled = false;
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i];
		if (char === '"' && !angled) {
			quoted = !quoted;
		} else if (!quoted && char === '<') {
			angled = true;
		} else if (!quoted && char === '>') {
			angled = false;
		} else if (!quoted && !angled && (char === ',' || char === ';')) {
			indices.push(i);
		}
	}
	return indices;
}

/** Splits a recipient field's text on its top-level separators only. */
function splitEntries(value: string): string[] {
	const entries: string[] = [];
	let start = 0;
	for (const index of separatorIndices(value)) {
		entries.push(value.slice(start, index));
		start = index + 1;
	}
	entries.push(value.slice(start));
	return entries;
}

/**
 * A single address, in the conservative subset described above: a local part of
 * printable non-whitespace characters without `@`, then a dotted domain whose
 * labels are alphanumeric-with-hyphens and whose TLD is at least two letters.
 *
 * Anchored, and with no `+`-quantified group that can match the same text two
 * ways — a recipient list is pasted, sender-adjacent input, so the pattern must
 * not be able to backtrack badly on it.
 */
const ADDRESS_PATTERN =
	/^[^\s@,;<>"]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

/**
 * Pulls the address out of one entry of a recipient list, accepting the
 * `Name <addr@example.com>` form a copy-paste from another client produces.
 *
 * The display name is dropped rather than preserved: this app sends with the
 * owner's own `from`, and a recipient display name is decoration that would
 * otherwise have to survive the round trip through a form field, the send call
 * and the `to_emails` column for no benefit to the reader.
 */
function extractAddress(entry: string): string {
	const angled = /<([^<>]*)>\s*$/.exec(entry.trim());
	return (angled ? angled[1] : entry).trim();
}

/** True when `value` is a single address this app will accept as a recipient. */
export function isValidAddress(value: string): boolean {
	return ADDRESS_PATTERN.test(value.trim());
}

export type ParsedAddressList = {
	/** Valid addresses, lowercased and de-duplicated, in the order first seen. */
	addresses: string[];
	/** Entries that are non-empty but not acceptable addresses, as typed. */
	invalid: string[];
};

/**
 * Parses a recipient field's raw text into valid addresses and rejects.
 *
 * Addresses are lowercased and de-duplicated because that is also how
 * `contacts.email` is stored (see `normalizeEmail` in `server/db/contacts.ts`)
 * — a list holding `A@x.com` and `a@x.com` is one recipient, and sending it
 * twice would be a duplicate delivery, not a second person.
 *
 * Empty entries are silently dropped, not reported: a trailing comma is how
 * someone types the *next* address, and flagging it would make the field shout
 * at every keystroke.
 */
export function parseAddressList(value: string): ParsedAddressList {
	const addresses: string[] = [];
	const seen = new Set<string>();
	const invalid: string[] = [];

	for (const entry of splitEntries(value)) {
		const candidate = extractAddress(entry);
		if (candidate === '') continue;

		if (!isValidAddress(candidate)) {
			invalid.push(candidate);
			continue;
		}

		const normalized = candidate.toLowerCase();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		addresses.push(normalized);
	}

	return { addresses, invalid };
}

export type ComposeDraft = {
	to: string;
	cc: string;
	subject: string;
	body: string;
};

export type ComposeValidation = {
	/** True when this draft may be sent. */
	valid: boolean;
	/**
	 * The parsed recipients, so the send path doesn't parse a second time.
	 *
	 * Populated whether or not the draft is valid (an invalid To still yields
	 * whatever addresses did parse); only read them when `valid` is true.
	 */
	to: string[];
	cc: string[];
	/** Field-keyed messages, absent when that field has nothing wrong with it. */
	errors: Partial<Record<'to' | 'cc' | 'content', string>>;
};

/**
 * The send gate (US-H01's fourth criterion): at least one To address, and a
 * subject or a body.
 *
 * "Subject **or** body" is the criterion as written, and it is the right rule:
 * a one-line "Re: lunch?" with no body and a body-only note to someone who will
 * recognise the sender are both real emails. Only a message with neither is
 * nothing at all.
 *
 * A malformed Cc blocks the send even though Cc is optional — a typo'd Cc is a
 * recipient who silently doesn't receive the mail, which is worse than being
 * told to fix it. An *empty* Cc is fine, which is what makes the field optional.
 */
export function validateComposeDraft(draft: ComposeDraft): ComposeValidation {
	const to = parseAddressList(draft.to);
	const cc = parseAddressList(draft.cc);
	const errors: ComposeValidation['errors'] = {};

	if (to.invalid.length > 0) {
		errors.to = `Not a valid address: ${to.invalid.join(', ')}`;
	} else if (to.addresses.length === 0) {
		errors.to = 'Add at least one recipient.';
	}

	// Cross-field duplicates matter as much as within-field ones: `parseAddressList`
	// de-duplicates each field on its own, so the same person in both To and Cc
	// would otherwise pass and be delivered to twice by one send.
	const ccOnly = cc.addresses.filter((address) => !to.addresses.includes(address));
	const duplicated = cc.addresses.filter((address) => to.addresses.includes(address));

	if (cc.invalid.length > 0) {
		errors.cc = `Not a valid address: ${cc.invalid.join(', ')}`;
	} else if (duplicated.length > 0) {
		errors.cc = `Already in To: ${duplicated.join(', ')}`;
	}

	if (draft.subject.trim() === '' && draft.body.trim() === '') {
		errors.content = 'Add a subject or a message body.';
	}

	return { valid: Object.keys(errors).length === 0, to: to.addresses, cc: ccOnly, errors };
}

export type ContactSuggestion = {
	email: string;
	name: string | null;
};

/**
 * The address fragment the caret is inside — i.e. the entry being typed, which
 * is the only one autocomplete should react to.
 *
 * Returned with its offsets so `replaceActiveEntry` can put the chosen contact
 * back exactly where the fragment was, leaving the already-committed addresses
 * on either side untouched.
 */
export function activeEntry(
	value: string,
	caret: number
): { text: string; start: number; end: number } {
	const clamped = Math.max(0, Math.min(caret, value.length));
	const separators = separatorIndices(value);
	// The nearest separator on each side of the caret — the same top-level scan
	// the splitter uses, so a comma inside `"Doe, Jane" <…>` doesn't look like an
	// entry boundary here either.
	const before = separators.filter((index) => index < clamped);
	const after = separators.filter((index) => index >= clamped);
	const start = before.length === 0 ? 0 : before[before.length - 1] + 1;
	const end = after.length === 0 ? value.length : after[0];
	return { text: value.slice(start, end), start, end };
}

/**
 * Rewrites the entry the caret is in as `address`, followed by a separator so
 * the field is ready for the next recipient.
 *
 * Returns the new caret position as well: after picking a contact the caret
 * belongs after the separator, not wherever it happened to be inside the
 * fragment that was just replaced.
 */
export function replaceActiveEntry(
	value: string,
	caret: number,
	address: string
): { value: string; caret: number } {
	const entry = activeEntry(value, caret);
	const before = value.slice(0, entry.start).trimEnd();
	// `entry.end` sits *on* the separator that closed the fragment, so the tail
	// has to shed it — the separator this function writes is the one that belongs
	// there, and keeping both leaves an empty `, ,` entry behind.
	const after = value
		.slice(entry.end)
		.replace(/^[,;]\s*/, '')
		.trimStart();
	const prefix = before === '' ? '' : `${before.replace(/[,;]\s*$/, '')}, `;
	const head = `${prefix}${address}, `;
	return { value: `${head}${after}`, caret: head.length };
}

/**
 * Contacts matching the fragment being typed, best-first, capped at
 * `MAX_CONTACT_SUGGESTIONS`.
 *
 * Matching is a substring test on the address *and* the display name, because
 * the owner knows some contacts by name and some by address, and a name-only
 * match is useless if it can't be found by the thing you remember. Prefix
 * matches sort ahead of mid-string ones so typing `ca` offers `casey@…` before
 * `luca@…`.
 *
 * Addresses already committed elsewhere in the field are excluded: re-offering a
 * recipient the field already holds can only produce a duplicate that
 * `parseAddressList` would then drop.
 */
export function suggestContacts(
	contacts: ContactSuggestion[],
	fragment: string,
	alreadyUsed: string[] = []
): ContactSuggestion[] {
	const needle = fragment.trim().toLowerCase();
	if (needle === '') return [];

	const used = new Set(alreadyUsed.map((address) => address.toLowerCase()));
	const scored: { contact: ContactSuggestion; rank: number }[] = [];

	for (const contact of contacts) {
		const email = contact.email.toLowerCase();
		if (used.has(email)) continue;

		const name = contact.name?.toLowerCase() ?? '';
		const emailAt = email.indexOf(needle);
		const nameAt = name === '' ? -1 : name.indexOf(needle);
		if (emailAt === -1 && nameAt === -1) continue;

		// Rank, low wins: an address prefix, then a name prefix, then any
		// substring hit. Ties keep the caller's order (which the load sorts).
		const rank = emailAt === 0 ? 0 : nameAt === 0 ? 1 : 2;
		scored.push({ contact, rank });
	}

	return scored
		.map((entry, index) => ({ ...entry, index }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.slice(0, MAX_CONTACT_SUGGESTIONS)
		.map((entry) => entry.contact);
}
