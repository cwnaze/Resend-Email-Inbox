// Contacts list load (US-I01) and the inline rename action (US-I02).
//
// The *load* is covered by `(app)/+layout.server.ts` — the session choke point
// for page renders — and only reads, so it deliberately has no second session
// check. The **action** below does check, because SvelteKit runs an action
// before any `load`: without it an anonymous POST would rename the contact and
// only then be redirected to `/login`. See `docs/notes/auth.md`.
import { error, fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	createContact,
	listContacts,
	MAX_CONTACT_EMAIL_LENGTH,
	MAX_CONTACT_NAME_LENGTH,
	updateContactName
} from '$lib/server/db/contacts';
import { validateSession } from '$lib/server/auth/session';
import { isValidAddress } from '$lib/compose/addresses';

export const load: PageServerLoad = async ({ url }) => {
	const rows = await listContacts(db);

	// Which row is open for editing lives in the URL (`?edit=<id>`) rather than
	// in component state, so the edit affordance is a plain link and the form is
	// server-rendered: it works with JavaScript off, a refresh keeps the form
	// open, and `fail()` can re-render the page still in edit mode (the action
	// URL carries `edit` too — see the action). An id matching no row opens
	// nothing.
	const editingId = url.searchParams.get('edit');

	// Same idea for the add form (US-I03): `?add` is what opens it, so the
	// "Add contact" affordance is a link, the form is server-rendered, and a
	// `fail()` can come back with it still open and still filled in.
	const adding = url.searchParams.has('add');

	// `displayName` is resolved here rather than in the component because it is
	// also what the query sorted by — deriving it twice is how the heading and
	// the ordering drift apart. The timestamp stays a `Date` (SvelteKit
	// serializes it as one) so the row can render both a relative label and a
	// machine-readable `datetime`, same as `ThreadRow`.
	return {
		editingId,
		adding,
		maxNameLength: MAX_CONTACT_NAME_LENGTH,
		maxEmailLength: MAX_CONTACT_EMAIL_LENGTH,
		contacts: rows.map((row) => ({
			id: row.id,
			displayName: row.name?.trim() || row.email,
			// The raw stored name, which is what the edit field is seeded with:
			// `displayName`'s address fallback is a *rendering*, and pre-filling the
			// input with it would turn "this contact has no name" into "this contact
			// is named after its own address" on the first save.
			name: row.name,
			email: row.email,
			messageCount: row.messageCount,
			lastContactedAt: row.lastContactedAt
		}))
	};
};

export const actions = {
	/**
	 * Renames one contact (US-I02).
	 *
	 * A form action rather than a fetch: it mutates, so it has to be a POST, and
	 * as an action it re-runs this page's `load` on the way out — the list
	 * re-sorts around the new name for free, with no second "patch the row in
	 * place" path that could disagree with `listContacts` about the order.
	 *
	 * **It validates the session itself**; see the file header.
	 *
	 * The call site posts to `?/rename&edit=<id>`, not just `?/rename`: a form
	 * action's query *replaces* the page's, so on `fail()` the re-render would
	 * otherwise come back with no `edit` param and silently close the very form
	 * the owner is being asked to correct.
	 */
	rename: async ({ cookies, request }) => {
		const session = await validateSession(db, cookies);
		if (!session) error(401, 'Not authenticated');

		const form = await request.formData();
		const id = form.get('id');
		const name = form.get('name');
		if (typeof id !== 'string' || id === '') error(400, 'Missing contact id');
		if (typeof name !== 'string') error(400, 'Missing name');

		// `maxlength` on the input is a courtesy to the browser, not the rule.
		const trimmed = name.trim();
		if (trimmed.length > MAX_CONTACT_NAME_LENGTH) {
			// The rejected text comes back with the failure, and the form re-seeds
			// from it. Without that, keeping the form open (the whole reason `edit`
			// rides in the action URL) buys nothing: the field would re-render from
			// the *stored* name, so "correct it and save again" would mean retyping
			// from scratch. `name`, not `trimmed` — echo back what was typed.
			return fail(400, {
				// `intent` discriminates this payload from `add`'s: `+page.svelte`
				// receives the union of every action's failure and has to know which
				// form the message belongs to before it reads any other field.
				intent: 'rename' as const,
				id,
				name,
				message: `Name must be ${MAX_CONTACT_NAME_LENGTH} characters or fewer.`
			});
		}

		const updated = await updateContactName(db, id, trimmed);
		if (!updated) error(404, 'Contact not found');

		// Redirect rather than return: this form is deliberately not `use:enhance`d,
		// so without it the owner is left sitting on the action's own POST URL
		// (`?/rename&edit=…` in the address bar, a refresh re-submitting the
		// rename). The target drops `edit`, which is what closes the form.
		redirect(303, resolve('/(app)/contacts'));
	},

	/**
	 * Adds a contact by hand (US-I03), before that address has ever emailed the
	 * owner — which is the whole point: `upsertAutoContact` only ever runs on
	 * mail that already exists, so without this there is no way to get an address
	 * into the compose autocomplete ahead of the first message.
	 *
	 * **It validates the session itself** for the same reason `rename` does; see
	 * the file header. Posts to `?/add&add=1` so a `fail()` re-render comes back
	 * with the form still open.
	 */
	add: async ({ cookies, request }) => {
		const session = await validateSession(db, cookies);
		if (!session) error(401, 'Not authenticated');

		const form = await request.formData();
		const email = form.get('email');
		const name = form.get('name');
		if (typeof email !== 'string') error(400, 'Missing email');
		if (typeof name !== 'string') error(400, 'Missing name');

		// Every rejection echoes back *both* fields, not just the offending one:
		// this form has two, and re-rendering it with the good one blanked would
		// make fixing a typo in the other mean retyping it.
		const invalid = (message: string, conflictId: string | null = null) =>
			fail(400, { intent: 'add' as const, name, email, message, conflictId });

		const trimmedName = name.trim();
		const trimmedEmail = email.trim();
		if (trimmedEmail === '') return invalid('Email address is required.');
		if (trimmedEmail.length > MAX_CONTACT_EMAIL_LENGTH) {
			return invalid(`Email address must be ${MAX_CONTACT_EMAIL_LENGTH} characters or fewer.`);
		}
		// The *same* address rule the compose recipient field and the send action
		// use — a contact exists to be addressed from compose, so an address this
		// page accepts but Send rejects would be a contact the owner can't use.
		if (!isValidAddress(trimmedEmail)) return invalid('Enter a valid email address.');
		if (trimmedName.length > MAX_CONTACT_NAME_LENGTH) {
			return invalid(`Name must be ${MAX_CONTACT_NAME_LENGTH} characters or fewer.`);
		}

		// The duplicate check is the insert itself (see `createContact`): a
		// pre-read would still race, and the conflicting row is what the error has
		// to name.
		const result = await createContact(db, { email: trimmedEmail, name: trimmedName });
		if (!result.created) {
			const existing = result.contact;
			const label = existing.name?.trim()
				? `${existing.name.trim()} <${existing.email}>`
				: existing.email;
			return invalid(`${label} is already a contact.`, existing.id);
		}

		redirect(303, resolve('/(app)/contacts'));
	}
} satisfies Actions;
