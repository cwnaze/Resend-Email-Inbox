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
import {
	forwardBody,
	forwardSubject,
	replyBody,
	replyRecipients,
	replySubject
} from '$lib/compose/reply';
import {
	absoluteTime,
	addressListLabel,
	bodyPlainText,
	formatFileSize,
	senderLabel
} from '$lib/inbox/format';
import { validateSession } from '$lib/server/auth/session';
import { getAttachmentsByEmailId } from '$lib/server/db/attachments';
import { getOutboundSender, sendOutboundEmail } from '$lib/server/email/resend';
import { newOutboundMessageId } from '$lib/server/outbound/message-id';
import {
	ForwardedAttachmentsTooLargeError,
	loadForwardedAttachments,
	storeForwardedAttachments,
	MAX_FORWARDED_ATTACHMENT_BYTES
} from '$lib/server/outbound/attachments';
import { storeSentEmail } from '$lib/server/outbound/store';
import { deleteFromR2, downloadFromR2, uploadToR2 } from '$lib/server/r2';

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
 * How this compose screen was opened: from scratch, from Reply (US-H03), or from
 * Forward (US-H04).
 *
 * Two query parameters rather than a `mode=` plus a shared id, because the two
 * links are written independently in `ThreadMessage.svelte` and a shared id with
 * a separate mode flag can arrive half-specified. If both are somehow present,
 * `replyTo` wins — one deterministic answer beats an error page for a URL only a
 * hand-edit can produce.
 */
type ComposeMode = 'reply' | 'forward';

function composeSource(url: URL): { mode: ComposeMode; emailId: string } | null {
	const replyTo = url.searchParams.get('replyTo');
	if (replyTo) return { mode: 'reply', emailId: replyTo };
	const forwardOf = url.searchParams.get('forwardOf');
	if (forwardOf) return { mode: 'forward', emailId: forwardOf };
	return null;
}

/**
 * The message a reply is answering or a forward is passing on, looked up from
 * `?replyTo=<email id>` (US-H03) / `?forwardOf=<email id>` (US-H04).
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
async function loadParent(emailId: string | null): Promise<Email | null> {
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

/**
 * The pre-filled draft for a forward of `parent` (US-H04).
 *
 * **To is empty, and that is the story.** A forward's whole premise is that the
 * recipient is someone new; pre-filling anybody — the original sender, the
 * original recipients — is one un-noticed Send away from mailing a private
 * message back to the person it came from.
 */
function forwardDraft(parent: Email): ComposeDraft {
	return {
		to: '',
		cc: '',
		subject: forwardSubject(parent.subject),
		body: forwardBody({
			sender: senderLabel(parent.fromName, parent.fromEmail),
			timestamp: absoluteTime(parent.receivedAt),
			subject: parent.subject.trim(),
			to: addressListLabel(parent.toEmails),
			// The same plain-text rendering the thread view shows, for the reason the
			// reply draft uses it: a plain-text send has nowhere to put markup.
			body: bodyPlainText(parent.bodyText, parent.bodyHtml)
		})
	};
}

export const load: PageServerLoad = async ({ url }) => {
	const source = composeSource(url);
	const parent = await loadParent(source?.emailId ?? null);
	// The files this forward will carry, for display only. The *send* re-reads
	// them from the parent row (`loadForwardedAttachments`) — nothing here is
	// trusted on the way back in.
	const attachments =
		parent && source?.mode === 'forward' ? await getAttachmentsByEmailId(db, parent.id) : [];

	return {
		contacts: await listContactsForSuggestions(db),
		// Null on the ordinary compose screen. When present the page seeds its
		// fields from it and carries the id back on submit.
		// `threadId` is here for the page's back-link only; the *send* re-reads what
		// it needs from the row rather than trusting a round trip.
		context:
			parent && source
				? {
						mode: source.mode,
						emailId: parent.id,
						threadId: parent.threadId,
						draft: source.mode === 'reply' ? replyDraft(parent) : forwardDraft(parent),
						// `id` is the list's key: two attachments on one message can share
						// a filename (see `inbound/attachments.ts`), so keying the rendered
						// list by name or size would collide.
						attachments: attachments.map((attachment) => ({
							id: attachment.id,
							filename: attachment.filename,
							size: formatFileSize(attachment.sizeBytes)
						}))
					}
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
		const source = composeSource(url);
		const parent = await loadParent(source?.emailId ?? null);
		const forwarding = parent !== null && source?.mode === 'forward';

		const validation = validateComposeDraft(draft);
		if (!validation.valid) {
			return fail(400, { draft, errors: validation.errors } satisfies ComposeResult);
		}

		// The forwarded files are read *before* the send and a failure refuses it,
		// which is the opposite of how attachments are treated everywhere else in
		// this app. Mail cannot be un-sent: a forward whose attachment quietly went
		// missing is a message that says "see attached" and doesn't, and the owner
		// has no way to know. Failing now costs a retry with the draft still on
		// screen (FR-4).
		let forwardedAttachments: Awaited<ReturnType<typeof loadForwardedAttachments>> = [];
		if (forwarding) {
			try {
				forwardedAttachments = await loadForwardedAttachments(db, parent.id, {
					download: downloadFromR2
				});
			} catch (error) {
				console.error('forward could not read its attachments:', parent.id, error);
				const tooLarge = error instanceof ForwardedAttachmentsTooLargeError;
				return fail(tooLarge ? 400 : 502, {
					draft,
					error: tooLarge
						? `These attachments are too large to forward (limit ${formatFileSize(MAX_FORWARDED_ATTACHMENT_BYTES)}).`
						: 'Could not read this message’s attachments. Nothing was sent — try again.'
				} satisfies ComposeResult);
			}
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
		//
		// A **forward cites nothing**. It is a new conversation with a new person
		// (US-H04's second criterion makes that explicit for the thread), and
		// `In-Reply-To` pointing at a message the recipient has never seen would ask
		// their client to file this mail under a thread it doesn't have.
		const inReplyTo = forwarding ? null : (parent?.messageId ?? null);

		try {
			await sendOutboundEmail({
				to: validation.to,
				cc: validation.cc,
				subject,
				text: draft.body,
				messageId,
				inReplyTo,
				attachments: forwardedAttachments.map((attachment) => ({
					filename: attachment.filename,
					contentType: attachment.contentType,
					content: attachment.bytes
				}))
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
				// thread, which is what composing from scratch means — and what a
				// *forward* means too (US-H04): the recipient is new, so the
				// conversation is new. Burying it in the original thread would file a
				// message to a third party under a conversation they were never part
				// of, and the thread view would show it as a reply that never came.
				threadId: forwarding ? null : (parent?.threadId ?? null),
				fromEmail: from,
				toEmails: validation.to,
				ccEmails: validation.cc,
				subject,
				bodyText: draft.body
			});

			// Deliberately outside `storeSentEmail`'s transaction and after it: this
			// is R2 work, and an upload cannot be rolled back by a database rollback.
			// Best-effort, per `storeForwardedAttachments` — the mail is already out,
			// so a failed copy costs the owner's own record of a file the recipient
			// already has, and it must not turn a delivered message into an error.
			let warning: string | undefined;
			if (forwardedAttachments.length > 0) {
				const { failed } = await storeForwardedAttachments(db, email.id, forwardedAttachments, {
					upload: (key, body, contentType) => uploadToR2(key, body, contentType),
					remove: deleteFromR2
				});
				if (failed.length > 0) {
					warning = 'Delivered with its attachments, but your copy of them could not be saved.';
				}
			}

			return { draft, sent: true, threadId: email.threadId, warning } satisfies ComposeResult;
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
