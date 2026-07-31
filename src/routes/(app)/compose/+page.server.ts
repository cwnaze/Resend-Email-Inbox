// The compose screen's load (US-H01, tasks/prd-feature-compose.md).
//
// Auth for the *render* is already guaranteed by `(app)/+layout.server.ts`, the
// single session choke point for this route group, so the load deliberately has
// no second check. The action below is a different matter — see its comment.
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { listContactsForSuggestions } from '$lib/server/db/contacts';
import { getVisibleEmailById, type Email } from '$lib/server/db/emails';
import {
	validateComposeDraft,
	type ComposeDraft,
	type ComposeValidation
} from '$lib/compose/addresses';
import { replyBody, replyRecipients, replySubject } from '$lib/compose/reply';
import { absoluteTime, bodyPlainText, senderLabel } from '$lib/inbox/format';
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

/**
 * The message a reply is answering, looked up from `?replyTo=<email id>`
 * (US-H03).
 *
 * **The id is the only thing the browser gets to choose**, and the *only* thing
 * it can choose. Every value that follows from it — the recipient, the subject,
 * the quoted text, the thread the send joins, the `In-Reply-To` it cites — is
 * read from the row here, in both the load *and* the action. Round-tripping any
 * of them through a hidden input would let a POST name one message's thread
 * while quoting another's, and `threadId` in particular is what decides where a
 * sent message lands: accepting it from a form is accepting "file this reply in
 * whatever thread the client says".
 *
 * Missing or unknown id → null, not a 404: `?replyTo=` naming a message that was
 * deleted between the thread render and the click should open the ordinary
 * compose screen (the owner can still write to whoever they meant), not an error
 * page.
 */
async function loadReplyTarget(emailId: string | null): Promise<Email | null> {
	if (!emailId) return null;
	return (await getVisibleEmailById(db, emailId)) ?? null;
}

/** The pre-filled draft for a reply to `parent` (US-H03, FR-2). */
function replyDraft(parent: Email): ComposeDraft {
	return {
		to: replyRecipients(parent, getOutboundSender()).join(', '),
		// Cc is deliberately *not* carried over. "Reply", not "Reply all": silently
		// re-addressing everyone the original copied is the one mistake in a mail
		// client that cannot be taken back, and the Cc field is one click away.
		cc: '',
		subject: replySubject(parent.subject),
		body: replyBody({
			sender: senderLabel(parent.fromName, parent.fromEmail),
			timestamp: absoluteTime(parent.receivedAt),
			// The same plain-text rendering the thread view shows, HTML-only bodies
			// included — quoting raw markup into a plain-text send would paste tags
			// into the reply.
			body: bodyPlainText(parent.bodyText, parent.bodyHtml)
		})
	};
}

export const load: PageServerLoad = async ({ url }) => {
	const parent = await loadReplyTarget(url.searchParams.get('replyTo'));
	return {
		contacts: await listContactsForSuggestions(db),
		// Null on the ordinary compose screen. When present the page seeds its
		// fields from it and carries the id back on submit.
		// `threadId` is here for the page's back-link only; the *send* re-reads it
		// from the row rather than trusting a round trip.
		reply: parent
			? { emailId: parent.id, threadId: parent.threadId, draft: replyDraft(parent) }
			: null
	};
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
	send: async ({ cookies, request, url }) => {
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

		// The reply target comes from the *same* place the load read it — the query
		// string, which the page's form action carries across the POST (see the
		// `replyAction` comment in `+page.svelte`) — so the screen that was rendered
		// and the send that follows it can never disagree about what is being
		// replied to. Only the id travels; everything else is re-read from the row
		// (`loadReplyTarget`).
		//
		// A reply whose parent has since been deleted degrades to a new thread
		// rather than failing the send: the message the owner wrote is still worth
		// delivering, and inbound's subject fallback usually re-joins it anyway.
		const parent = await loadReplyTarget(url.searchParams.get('replyTo'));

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
		// The parent's *stored* `message_id` — the id this app knows about, which for
		// an inbound parent is the id its sender's client minted and for an outbound
		// one is the id `outbound/message-id.ts` minted. Either way it is the value a
		// receiving client will echo back, so it is the right thing to cite.
		const inReplyTo = parent?.messageId ?? null;

		try {
			await sendOutboundEmail({
				to: validation.to,
				cc: validation.cc,
				subject,
				text: draft.body,
				messageId,
				inReplyTo
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
				inReplyTo,
				// The thread comes from the parent *row*, so a reply lands in the same
				// thread as the message it answers no matter what the headers do on the
				// wire (US-H03, FR-2). This is the reliable half of threading: the
				// header path is best-effort in this direction because SES rewrites
				// `Message-ID` — see `docs/notes/compose.md`. Null here starts a new
				// thread, which is what composing from scratch means.
				threadId: parent?.threadId ?? null,
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
