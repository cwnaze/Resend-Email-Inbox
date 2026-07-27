// POST /api/webhooks/resend-inbound (US-E01)
//
// Resend delivers inbound mail here. Every request is Svix-verified against the
// raw body *before* anything is parsed or persisted (FR-1,
// tasks/prd-feature-inbound-processing.md). Parsing, contact upsert, HTML
// sanitization, threading and attachment upload land in US-E02..E05 — this
// story is the gate in front of them.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifySvixRequest } from '$lib/server/webhooks/svix';

export const POST: RequestHandler = async ({ request }) => {
	const result = await verifySvixRequest(request);

	if (!result.ok) {
		// Log the reason server-side; the client gets a bare 401. Telling an
		// unauthenticated caller *why* its signature failed only helps it forge a
		// better one.
		console.warn('rejected inbound webhook:', result.reason);
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Verified. US-E02 takes over from `result.payload` here.
	return json({ ok: true });
};
