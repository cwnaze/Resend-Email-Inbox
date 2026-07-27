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
import { normalizeSubject } from '../inbound/threading.js';

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

		// Remove this script's own leftovers from a previous run. Without it the
		// very first ingest below is answered as a duplicate and every assertion
		// about the *newly stored* row silently describes whatever an older run
		// wrote — which is how a stale, pre-US-E04 thread row survived here.
		// Emails first, then their now-empty threads: `emails.thread_id` is a real
		// FK and this connection enforces it.
		const { rows: staleThreads } = await turso.execute({
			sql: 'select thread_id from emails where message_id = ?',
			args: [received.message_id]
		});
		await turso.execute({
			sql: 'delete from emails where message_id = ?',
			args: [received.message_id]
		});
		for (const row of staleThreads) {
			await turso.execute({
				sql: 'delete from threads where id = ? and not exists (select 1 from emails where thread_id = ?)',
				args: [row.thread_id, row.thread_id]
			});
		}

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

		// US-E03: the email itself is stored, exactly once, with sanitized HTML.
		const { rows: emailRows } = await turso.execute({
			sql: 'select count(*) as n, max(body_html) as html from emails where message_id = ?',
			args: [received.message_id]
		});
		const storedOnce = Number(emailRows[0].n) === 1;
		if (!storedOnce) failures++;
		console.log(
			`${storedOnce ? 'PASS' : 'FAIL'}  email stored exactly once after redelivery -> ${emailRows[0].n} row(s) (expected 1)`
		);

		const storedHtml = typeof emailRows[0].html === 'string' ? emailRows[0].html : '';
		const sanitized = !/<script|\son\w+\s*=|<iframe/i.test(storedHtml);
		if (!sanitized) failures++;
		console.log(
			`${sanitized ? 'PASS' : 'FAIL'}  stored body_html contains no script/handler/iframe markup`
		);

		// US-E04: the stored email hangs off a real thread whose subject is the
		// normalized one and whose sort/read state matches the message.
		const { rows: threadRows } = await turso.execute({
			sql: `select t.subject as subject, t.is_read as is_read,
			             t.last_message_at as last_message_at, e.received_at as received_at
			      from emails e join threads t on t.id = e.thread_id
			      where e.message_id = ?`,
			args: [received.message_id]
		});
		const thread = threadRows[0];
		const threaded =
			thread !== undefined &&
			thread.subject === normalizeSubject(received.subject ?? '') &&
			Number(thread.is_read) === 0 &&
			Number(thread.last_message_at) >= Number(thread.received_at);
		if (!threaded) failures++;
		console.log(
			`${threaded ? 'PASS' : 'FAIL'}  email is attached to a thread with the normalized subject, unread, sorted by its own timestamp`
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

		// A verified envelope naming an `email_id` Resend will never serve (a 4xx
		// from the Received-emails API) must be *ignored* with a 200, not 500'd:
		// Resend retries 5xx, and no number of retries can make a missing email
		// appear. Only a transient failure is allowed to reach a 500.
		const missingBody = JSON.stringify({
			type: 'email.received',
			data: { email_id: '00000000-0000-4000-8000-000000000000' }
		});
		await check('permanently-unfetchable email_id is ignored, not retried', 200, {
			headers: sign(missingBody, 'msg_us_e02_missing', new Date()),
			body: missingBody
		});

		turso.close();
	}
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log('\nAll webhook checks passed');
