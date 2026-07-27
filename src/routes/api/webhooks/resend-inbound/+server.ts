// POST /api/webhooks/resend-inbound (US-E01..E04)
//
// Resend delivers inbound mail here. Every request is Svix-verified against the
// raw body *before* anything is parsed or persisted (FR-1,
// tasks/prd-feature-inbound-processing.md).
//
// US-E01 built the verification gate. US-E02 added parsing and the sender
// contact upsert. US-E03 adds HTML sanitization + the idempotent `emails`
// insert (`storeInboundEmail`), and US-E04 thread assignment inside it too.
// US-E05 hangs attachment download + R2 upload off the same `parsed` object.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifySvixRequest } from '$lib/server/webhooks/svix';
import { parseInboundWebhookEvent, parseReceivedEmail } from '$lib/server/inbound/parse';
import {
	fetchReceivedAttachmentBytes,
	fetchReceivedEmail,
	ReceivedEmailFetchError
} from '$lib/server/email/resend';
import { storeInboundAttachments } from '$lib/server/inbound/attachments';
import { deleteFromR2, uploadToR2 } from '$lib/server/r2';
import { upsertContactFromInbound } from '$lib/server/db/contacts';
import { storeInboundEmail } from '$lib/server/inbound/store';
import { db } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
	const result = await verifySvixRequest(request);

	if (!result.ok) {
		// Log the reason server-side; the client gets a bare 401. Telling an
		// unauthenticated caller *why* its signature failed only helps it forge a
		// better one.
		console.warn('rejected inbound webhook:', result.reason);
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const event = parseInboundWebhookEvent(result.payload);
	if (!event.ok) {
		// A verified-but-unusable payload is not ours to retry: answer 200 so
		// Resend doesn't redeliver it forever, and log what arrived.
		console.warn('ignoring inbound webhook payload:', event.reason);
		return json({ ok: true, ignored: true });
	}

	// The webhook is metadata-only — body, headers and attachments must be
	// fetched. A *transient* failure is allowed to throw → 500, which is exactly
	// when Resend's retry helps. A permanent one (4xx: the `email_id` is gone or
	// inaccessible) must answer 200 for the same reason an unusable payload does
	// — redelivering it forever cannot make it succeed.
	let received;
	try {
		received = await fetchReceivedEmail(event.emailId);
	} catch (err) {
		if (err instanceof ReceivedEmailFetchError && !err.retryable) {
			console.warn(
				`ignoring inbound webhook: received-email fetch failed permanently`,
				`(${event.emailId}, status ${err.statusCode})`
			);
			return json({ ok: true, ignored: true });
		}
		throw err;
	}
	const parsed = parseReceivedEmail(received);

	const { contact, created } = await upsertContactFromInbound(db, {
		email: parsed.fromEmail,
		name: parsed.fromName
	});

	// Deliberately no sender address in the log line: it would put a real
	// person's email address in the platform's function logs on every delivery,
	// and the contact id already identifies the row if it needs looking up.
	const { email, created: emailCreated, threadMatch } = await storeInboundEmail(db, parsed);

	// Attachments (US-E05) only on a genuinely new email: a redelivery's bytes are
	// already in R2 under the same key, and re-downloading them would burn the
	// whole ingestion budget re-uploading files this mailbox already has.
	let attachmentSummary = '';
	if (emailCreated && parsed.attachments.length > 0) {
		const { stored, failed } = await storeInboundAttachments(
			db,
			{
				emailId: email.id,
				resendEmailId: parsed.resendEmailId,
				attachments: parsed.attachments
			},
			{
				download: fetchReceivedAttachmentBytes,
				upload: (key, body, contentType) => uploadToR2(key, body, contentType),
				remove: (key) => deleteFromR2(key)
			}
		);
		attachmentSummary = ` attachments ${stored.length}/${parsed.attachments.length} stored${
			failed.length > 0 ? `, ${failed.length} failed` : ''
		};`;
	}

	console.log(
		`inbound email ${parsed.resendEmailId}`,
		`(contact ${contact.id} ${created ? 'created' : 'existing'};`,
		`email ${email.id} ${emailCreated ? 'stored' : 'duplicate, skipped'};`,
		`thread ${email.threadId} ${threadMatch};${attachmentSummary})`
	);

	return json({ ok: true, duplicate: !emailCreated });
};
