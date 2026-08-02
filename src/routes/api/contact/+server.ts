// POST /api/contact — public contact-form intake for caseynazelrod.com.
//
// The portfolio site is statically built and has no server of its own, so its
// form posts here cross-origin. The submission is stored directly as an inbound
// email (see `$lib/server/contact/submission`) — it does not go out through
// Resend and come back via the webhook, because nothing about the message needs
// to leave this system to reach the inbox.
//
// Resend is used for exactly one thing on this path: the auto-reply that
// acknowledges the submission to the person who sent it. That send is a courtesy
// and cannot fail the request.
//
// This is the app's only unauthenticated write, and — via that auto-reply — the
// only way an unauthenticated caller can cause mail to be sent from this domain.
// What guards it: a CORS allowlist, a per-address and per-IP rate limit, hard
// length caps, a honeypot field, and a fixed auto-reply body that never echoes
// submitted text back out. None of them is load-bearing alone.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { corsHeaders } from '$lib/server/contact/cors';
import { allowSubmission } from '$lib/server/contact/rate-limit';
import { storeContactSubmission, validateSubmission } from '$lib/server/contact/submission';
import { sendContactAutoReply } from '$lib/server/email/resend';

export const OPTIONS: RequestHandler = async ({ request }) => {
	return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('origin')) });
};

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const headers = corsHeaders(request.headers.get('origin'));

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400, headers });
	}

	// Honeypot: a hidden field no human fills in. Answer 200 rather than 400 — a
	// bot that learns which shape gets rejected just stops sending that shape.
	if (typeof body === 'object' && body !== null && (body as Record<string, unknown>).website) {
		return json({ ok: true }, { headers });
	}

	const validated = validateSubmission(body);
	if (!validated.ok) return json({ error: validated.reason }, { status: 400, headers });

	// Keyed on the submitted address *and* the client IP: the address alone lets
	// one bot rotate it freely, the IP alone lumps everyone behind a shared NAT
	// together. Either hitting its limit is enough to reject.
	const ip = getClientAddress();
	if (!allowSubmission(`email:${validated.value.email}`) || !allowSubmission(`ip:${ip}`)) {
		return json(
			{ error: 'Too many messages sent recently — please try again later.' },
			{ status: 429, headers }
		);
	}

	const { email, created } = await storeContactSubmission(db, validated.value);

	// No submitter address in the log line, matching the inbound webhook: the row
	// id is enough to find the message, and the platform's logs are not the place
	// for a real person's email address.
	console.log(
		`contact submission stored (email ${email.id}, thread ${email.threadId}, ${created ? 'new' : 'duplicate'})`
	);

	// Courtesy acknowledgement to the submitter. Awaited rather than fire-and-forget
	// — a serverless function can be frozen the moment its response is returned, so
	// a floating promise here is a send that may simply never happen. It swallows
	// its own failures by design: the message is already stored and the sender's
	// "sent" confirmation must not depend on Resend being reachable.
	await sendContactAutoReply(validated.value.email, validated.value.name);

	return json({ ok: true }, { headers });
};
