// Standalone smoke test for POST /api/webhooks/resend-inbound (US-E01).
//
// Drives the real endpoint on a running dev server with four request shapes and
// asserts the status of each: only a genuinely-signed body gets past the gate.
//
// Same standalone-script pattern as src/lib/server/r2/verify.mts and
// src/lib/server/auth/verify-auth-sessions.mts — reads `process.env` directly
// (not `$env/dynamic/private`, which only resolves inside Vite/SvelteKit), so
// run it as:
//
//   node --env-file=.env node_modules/.bin/tsx \
//     src/lib/server/webhooks/verify-inbound-webhook.mts
//
// with a dev server already listening on BASE_URL (override via WEBHOOK_BASE_URL).
import { Webhook } from 'svix';

const baseUrl = process.env.WEBHOOK_BASE_URL ?? 'http://localhost:5173';
const endpoint = `${baseUrl}/api/webhooks/resend-inbound`;

const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
if (!secret) {
	throw new Error('RESEND_INBOUND_WEBHOOK_SECRET is not set');
}
const webhook = new Webhook(secret);

// A stand-in for a Resend inbound payload, shaped like a real one (metadata
// only — the real webhook carries no body/headers/attachments). The signature
// cases below only care that the bytes are signed; the `email_id` here is
// deliberately not a real one, so the endpoint ignores it with a 200 rather
// than calling out to Resend. Part 2 covers the real-id path.
const body = JSON.stringify({
	type: 'email.received',
	data: { from: 'sender@example.com', subject: 'signed payload' }
});

function sign(payload: string, msgId: string, timestamp: Date) {
	const signature = webhook.sign(msgId, timestamp, payload);
	return {
		'svix-id': msgId,
		'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
		'svix-signature': signature,
		'content-type': 'application/json'
	};
}

let failures = 0;

async function check(label: string, expectedStatus: number, init: RequestInit) {
	const res = await fetch(endpoint, { method: 'POST', ...init });
	const ok = res.status === expectedStatus;
	if (!ok) failures++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${res.status} (expected ${expectedStatus})`);
}

const now = new Date();
const signedHeaders = sign(body, 'msg_us_e01_valid', now);

// 1. Correctly signed request is accepted.
await check('valid signature', 200, { headers: signedHeaders, body });

// 2. Same signature, mutated body: the signature covers the raw bytes, so
//    tampering must invalidate it.
await check('tampered body, original signature', 401, {
	headers: signedHeaders,
	body: body.replace('signed payload', 'tampered payload')
});

// 3. A syntactically valid but wrong signature (signed with a different secret).
const forged = new Webhook(
	`whsec_${Buffer.from('an-entirely-different-signing-secret').toString('base64')}`
);
await check('signature from a different secret', 401, {
	headers: {
		'svix-id': 'msg_us_e01_forged',
		'svix-timestamp': String(Math.floor(now.getTime() / 1000)),
		'svix-signature': forged.sign('msg_us_e01_forged', now, body),
		'content-type': 'application/json'
	},
	body
});

// 4. No Svix headers at all — rejected before the body is even read.
await check('no svix headers', 401, { headers: { 'content-type': 'application/json' }, body });

// 5. Partial headers (signature present, svix-id missing).
await check('missing svix-id header', 401, {
	headers: {
		'svix-timestamp': signedHeaders['svix-timestamp'],
		'svix-signature': signedHeaders['svix-signature'],
		'content-type': 'application/json'
	},
	body
});

// ---------------------------------------------------------------------------
// Part 2 (US-E02) — full ingestion path against a real received email.
//
// Skipped unless RESEND_API_KEY and the Turso vars are set, so the signature
// suite above stays runnable with nothing but a throwaway signing secret.
// Picks the most recent real inbound email in the Resend account (override with
// VERIFY_RECEIVED_EMAIL_ID), posts a genuinely-signed `email.received` envelope
// naming it, and asserts the sender landed in `contacts`.
// ---------------------------------------------------------------------------

const apiKey = process.env.RESEND_API_KEY;
const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;

if (!apiKey || !tursoUrl || !tursoToken) {
	console.log('\nskipping ingestion checks (RESEND_API_KEY / TURSO_* not set)');
} else {
	const { Resend } = await import('resend');
	const { createClient } = await import('@libsql/client');

	const resend = new Resend(apiKey);
	let emailId = process.env.VERIFY_RECEIVED_EMAIL_ID;

	if (!emailId) {
		const { data } = await resend.emails.receiving.list();
		emailId = data?.data[0]?.id;
	}

	if (!emailId) {
		console.log('\nskipping ingestion checks (no received emails in the Resend account yet)');
	} else {
		const { data: received } = await resend.emails.receiving.get(emailId);
		if (!received) throw new Error(`could not fetch received email ${emailId}`);
		const senderEmail = received.from.trim().toLowerCase();

		const turso = createClient({ url: tursoUrl, authToken: tursoToken });
		const countContact = async () => {
			const { rows } = await turso.execute({
				sql: 'select count(*) as n from contacts where lower(email) = ?',
				args: [senderEmail]
			});
			return Number(rows[0].n);
		};

		const before = await countContact();
		console.log(`\nreal received email ${emailId}: contacts rows for sender before = ${before}`);

		const ingestBody = JSON.stringify({
			type: 'email.received',
			created_at: received.created_at,
			data: { email_id: emailId, from: received.from, subject: received.subject }
		});
		await check('real email.received envelope is ingested', 200, {
			headers: sign(ingestBody, 'msg_us_e02_ingest', new Date()),
			body: ingestBody
		});

		const after = await countContact();
		const contacted = after === 1;
		if (!contacted) failures++;
		console.log(
			`${contacted ? 'PASS' : 'FAIL'}  sender upserted into contacts -> ${after} row(s) (expected 1)`
		);

		// Re-delivery (Resend retries) must not duplicate the contact.
		const retryBody = ingestBody;
		await check('redelivery of the same email is accepted', 200, {
			headers: sign(retryBody, 'msg_us_e02_retry', new Date()),
			body: retryBody
		});
		const afterRetry = await countContact();
		const stillOne = afterRetry === 1;
		if (!stillOne) failures++;
		console.log(
			`${stillOne ? 'PASS' : 'FAIL'}  redelivery did not duplicate -> ${afterRetry} row(s) (expected 1)`
		);

		// A verified payload for a *different* event type is ignored, not 500'd.
		const otherBody = JSON.stringify({
			type: 'email.delivered',
			data: { email_id: emailId }
		});
		await check('non-received event type is ignored', 200, {
			headers: sign(otherBody, 'msg_us_e02_other', new Date()),
			body: otherBody
		});

		turso.close();
	}
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log('\nAll webhook checks passed');
