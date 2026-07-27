// POST /api/webhooks/resend-inbound (US-E01, US-E02)
//
// Resend delivers inbound mail here. Every request is Svix-verified against the
// raw body *before* anything is parsed or persisted (FR-1,
// tasks/prd-feature-inbound-processing.md).
//
// US-E01 built the verification gate. US-E02 adds parsing and the sender
// contact upsert. HTML sanitization + `emails` insert (US-E03), thread
// assignment (US-E04) and attachment upload (US-E05) hang off the same
// `parsed` object below.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifySvixRequest } from '$lib/server/webhooks/svix';
import { parseInboundWebhookEvent, parseReceivedEmail } from '$lib/server/inbound/parse';
import { fetchReceivedEmail } from '$lib/server/email/resend';
import { upsertContactFromInbound } from '$lib/server/db/contacts';
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
	// fetched. A throw here surfaces as a 500, which is what we want: Resend
	// retries 5xx, and a transient API failure should not silently drop mail.
	const received = await fetchReceivedEmail(event.emailId);
	const parsed = parseReceivedEmail(received);

	const { contact, created } = await upsertContactFromInbound(db, {
		email: parsed.fromEmail,
		name: parsed.fromName
	});

	console.log(
		`inbound email ${parsed.resendEmailId} from ${parsed.fromEmail}`,
		`(contact ${contact.id} ${created ? 'created' : 'existing'})`
	);

	// US-E03 continues from `parsed` here: sanitize, dedupe on message_id, insert.
	return json({ ok: true });
};
