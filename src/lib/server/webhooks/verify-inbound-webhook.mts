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

// A minimal stand-in for a Resend inbound payload. US-E01 only cares that the
// bytes are signed, not what they contain.
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

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log('\nAll webhook signature checks passed');
