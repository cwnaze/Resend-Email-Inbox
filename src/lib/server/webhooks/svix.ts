// Svix webhook signature verification (server-only).
//
// Resend signs inbound webhook deliveries with Svix headers (`svix-id`,
// `svix-timestamp`, `svix-signature`) over the *raw* request body. This module
// is the single place that check lives — see tasks/prd-architecture.md
// ("Inbound Webhook Verification", FR-3) and tasks/prd-feature-inbound-processing.md
// (US-E01, FR-1).
//
// The env read is lazy (first verify, not module import), matching
// `src/lib/server/email/resend.ts`: `npm run build` imports every `+server.ts`
// to detect its exported HTTP methods, so an import-time `requireEnv` would
// make the build itself require a real secret.
import { Webhook } from 'svix';
import { env } from '$env/dynamic/private';

/** The three headers Svix signs with. Verification needs all three. */
const SVIX_HEADERS = ['svix-id', 'svix-timestamp', 'svix-signature'] as const;

let webhook: Webhook | undefined;

function getWebhook(): Webhook {
	if (!webhook) {
		const secret = env.RESEND_INBOUND_WEBHOOK_SECRET;
		if (!secret) {
			throw new Error('RESEND_INBOUND_WEBHOOK_SECRET is not set');
		}
		webhook = new Webhook(secret);
	}
	return webhook;
}

/**
 * Result of a verification attempt. `payload` is only ever populated on
 * success, so a caller physically cannot parse or persist an unverified body.
 *
 * `reason` is for the server log only — it deliberately never reaches the
 * client, which sees a bare 401 either way.
 */
export type VerifyResult =
	{ ok: true; payload: unknown; rawBody: string } | { ok: false; reason: string };

/**
 * Verifies a webhook request's Svix signature against the raw request body.
 *
 * Reads the body itself (as text, unparsed) because the signature covers the
 * exact bytes Resend sent — re-serializing a parsed object would change them
 * and fail verification. Callers must not call `request.json()` first; use the
 * returned `payload`/`rawBody` instead, since a `Request` body can only be
 * consumed once.
 */
export async function verifySvixRequest(request: Request): Promise<VerifyResult> {
	const headers: Record<string, string> = {};
	for (const name of SVIX_HEADERS) {
		const value = request.headers.get(name);
		if (!value) {
			return { ok: false, reason: `missing ${name} header` };
		}
		headers[name] = value;
	}

	// Resolved *outside* the try below: a missing secret is a server
	// misconfiguration, not a bad caller. Letting it throw surfaces a 500 (which
	// Resend retries) instead of a 401 that would silently drop every inbound
	// email while looking like an attacker probing the endpoint.
	const wh = getWebhook();

	const rawBody = await request.text();

	try {
		const payload = wh.verify(rawBody, headers);
		return { ok: true, payload, rawBody };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : 'signature verification failed'
		};
	}
}
