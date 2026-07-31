// The compose screen's load (US-H01, tasks/prd-feature-compose.md).
//
// Auth for the *render* is already guaranteed by `(app)/+layout.server.ts`, the
// single session choke point for this route group, so the load deliberately has
// no second check. The action below is a different matter — see its comment.
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { listContactsForSuggestions } from '$lib/server/db/contacts';
import {
	validateComposeDraft,
	type ComposeDraft,
	type ComposeValidation
} from '$lib/compose/addresses';
import { validateSession } from '$lib/server/auth/session';

/**
 * One shape for every outcome, success and failure alike.
 *
 * `ActionData` is a union of whatever the action can return, and a page that
 * reads `form?.errors` off a union whose success member has no `errors` does not
 * typecheck. Keeping the members structurally identical (optional fields rather
 * than different shapes) is what lets the page read the result without narrowing
 * gymnastics — worth doing here because US-H02 adds more outcomes to it.
 */
type ComposeResult = {
	/** Always echoed, so no failure path can lose typed content (FR-4). */
	draft: ComposeDraft;
	errors?: ComposeValidation['errors'];
	/** The draft passed validation. US-H01 sends nothing, so this is all it means. */
	accepted?: boolean;
	/** A whole-form failure, as opposed to a per-field validation message. */
	error?: string;
};

export const load: PageServerLoad = async () => {
	return { contacts: await listContactsForSuggestions(db) };
};

/** Reads one compose field out of a submitted form, tolerating its absence. */
function field(form: FormData, name: keyof ComposeDraft): string {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
}

export const actions = {
	/**
	 * Accepts the compose form and re-checks it server-side.
	 *
	 * **US-H01 stops here: nothing is sent and nothing is written.** Delivery and
	 * the outbound `emails` row are US-H02, and this action exists now so the
	 * gating criterion has a real submit target rather than a button wired to
	 * nothing — which also means the validation is enforced without JavaScript,
	 * not just by the disabled button.
	 *
	 * Every failure path returns the draft back to the page. That is US-H02's
	 * FR-4 ("send failures must never silently drop composed content") arriving
	 * early, and it is cheaper to build it in now than to retrofit it around a
	 * send call: the page renders from `form?.draft ?? ''`, so a failed submit
	 * re-renders what was typed.
	 *
	 * One honest limit on that: the **401** path's draft only reaches a caller that
	 * skips the loads (an `x-sveltekit-action` fetch). For an ordinary form POST,
	 * SvelteKit runs the page's `load` chain after the action, and
	 * `(app)/+layout.server.ts` redirects a session-less request to `/login` — that
	 * redirect wins and the returned draft is dropped. Preserving a draft across an
	 * expired session needs client-side storage, which is not this story; what
	 * matters here is that the refusal happens *before* anything is sent.
	 *
	 * **The session is validated here, in the action.** `(app)/+layout.server.ts`
	 * protects page renders, and SvelteKit runs an action *before* any `load`, so
	 * a POST would otherwise run its whole body before the layout ever redirected
	 * an anonymous caller. This action is inert today, but the rule (see
	 * `docs/notes/auth.md` and CLAUDE.md) is about the shape, not this body —
	 * US-H02 fills it in with a real send and must not have to remember.
	 */
	send: async ({ cookies, request }) => {
		// The body is read before the session is checked so that *every* return
		// path can echo the draft back — reading a form body is not a mutation, so
		// nothing has happened yet if the session then turns out to be invalid.
		const form = await request.formData();
		const draft: ComposeDraft = {
			to: field(form, 'to'),
			cc: field(form, 'cc'),
			subject: field(form, 'subject'),
			body: field(form, 'body')
		};

		const session = await validateSession(db, cookies);
		if (!session) return fail(401, { draft, error: 'Not authenticated.' } satisfies ComposeResult);

		const validation = validateComposeDraft(draft);
		if (!validation.valid) {
			return fail(400, { draft, errors: validation.errors } satisfies ComposeResult);
		}

		return { draft, accepted: true } satisfies ComposeResult;
	}
} satisfies Actions;
