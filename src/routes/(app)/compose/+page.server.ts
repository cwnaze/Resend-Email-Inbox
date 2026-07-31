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
import { getOutboundSender, sendOutboundEmail } from '$lib/server/email/resend';
import { newOutboundMessageId } from '$lib/server/outbound/message-id';
import { storeSentEmail } from '$lib/server/outbound/store';

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
	/** The message was handed to Resend and accepted (US-H02). */
	sent?: boolean;
	/** The thread the sent message landed in, so the page can link to it. */
	threadId?: string;
	/** A whole-form failure, as opposed to a per-field validation message. */
	error?: string;
	/**
	 * Delivered, but something after the send went wrong (the row didn't store).
	 * Reported *with* `sent: true`, never as an error — a delivered message shown
	 * as a failure invites a second send of the same mail.
	 */
	warning?: string;
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
	 * Re-checks the compose form server-side, sends it, and records what was sent
	 * (US-H02).
	 *
	 * Three steps in a fixed order, and the order is the whole design:
	 *
	 * 1. **Validate** with the same `validateComposeDraft` the button is gated on,
	 *    so the rule is enforced even without JavaScript.
	 * 2. **Send.** The only step whose failure means nothing happened, and
	 *    therefore the only one that offers a retry.
	 * 3. **Store.** Runs *after* delivery on purpose: the alternative (write the
	 *    row, then send) has to either roll back a committed row or leave an
	 *    `emails` row for mail that never went out, and a phantom sent message is
	 *    the worse of the two lies. The cost is the reverse gap — delivered but
	 *    unrecorded — which is why that case returns `sent: true` with a
	 *    `warning` instead of an error.
	 *
	 * Every path returns the draft back to the page (FR-4: "send failures must
	 * never silently drop composed content"), which is what makes the retry above
	 * a real one — the page renders from `form?.draft`, so a failed send
	 * re-renders exactly what was typed.
	 *
	 * One honest limit on that: the **401** path's draft only reaches a caller that
	 * skips the loads (an `x-sveltekit-action` fetch). For an ordinary form POST,
	 * SvelteKit runs the page's `load` chain after the action, and
	 * `(app)/+layout.server.ts` redirects a session-less request to `/login` — that
	 * redirect wins and the returned draft is dropped. Preserving a draft across an
	 * expired session needs client-side storage, which is not this story; what
	 * matters here is that the refusal happens *before* anything is sent.
	 *
	 * **The session is validated here, in the action — before anything is sent.**
	 * `(app)/+layout.server.ts` protects page renders, and SvelteKit runs an action
	 * *before* any `load`, so without this check a POST would run its whole body —
	 * now a real send on the owner's domain — before the layout ever redirected an
	 * anonymous caller. See `docs/notes/auth.md` and CLAUDE.md.
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

		// The recipients `validateComposeDraft` already parsed, not a second parse of
		// the raw fields: two parses are two rules waiting to disagree, and `cc` here
		// has had any address that is also in `to` removed.
		const from = getOutboundSender();
		const messageId = newOutboundMessageId(from);
		// Resend requires a subject, and the draft rule deliberately allows an empty
		// one when there is a body. A visible placeholder is better than either
		// refusing the send or letting the provider reject it.
		const subject = draft.subject.trim() === '' ? '(no subject)' : draft.subject.trim();

		try {
			await sendOutboundEmail({
				to: validation.to,
				cc: validation.cc,
				subject,
				text: draft.body,
				messageId
			});
		} catch (error) {
			// The send is the only step whose failure means "nothing happened", so it
			// is the only one that returns the draft for a retry (FR-4). `fail(502)`
			// rather than a thrown 500: an unhandled error renders the error page and
			// the composed message is gone.
			console.error('compose send failed:', error);
			return fail(502, {
				draft,
				error: 'Sending failed. Your message is still here — try again.'
			} satisfies ComposeResult);
		}

		// Past this point the mail is out. Nothing below may report failure in a way
		// that reads as "not sent", or the owner sends it twice.
		try {
			const { email } = await storeSentEmail(db, {
				messageId,
				// Threading a reply onto its parent is US-H03; a message composed here
				// starts its own thread.
				inReplyTo: null,
				threadId: null,
				fromEmail: from,
				toEmails: validation.to,
				ccEmails: validation.cc,
				subject,
				bodyText: draft.body
			});
			return { draft, sent: true, threadId: email.threadId } satisfies ComposeResult;
		} catch (error) {
			console.error('compose send stored no row:', messageId, error);
			return {
				draft,
				sent: true,
				warning: 'Delivered, but this copy could not be saved to your inbox.'
			} satisfies ComposeResult;
		}
	}
} satisfies Actions;
