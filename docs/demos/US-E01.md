# US-E01: Verify Resend inbound webhook signature

*2026-07-27T17:49:26Z by Showboat 0.6.1*
<!-- showboat-id: c318044d-51cd-4cb4-9f11-af8e3f288efd -->

Resend signs inbound webhook deliveries with Svix headers (`svix-id`, `svix-timestamp`, `svix-signature`) over the **raw** request body. This story puts that verification in front of the ingestion pipeline (US-E02..E05), so an unauthenticated payload can never be parsed or persisted.

Two new files plus one dependency:

- `src/lib/server/webhooks/svix.ts` — the single place the check lives. Exports `verifySvixRequest(request)`, which reads the three Svix headers, reads the body **as text** (the signature covers the exact bytes Resend sent, so re-serializing a parsed object would fail verification), and returns a discriminated result: `payload` is only ever present on the `ok: true` branch, so a caller physically cannot reach unverified content.
- `src/routes/api/webhooks/resend-inbound/+server.ts` — the `POST` endpoint. On failure it logs the reason server-side and returns a bare `401`; telling an unauthenticated caller *why* its signature failed only helps it forge a better one.

The `RESEND_INBOUND_WEBHOOK_SECRET` read is **lazy** (first verify, not module import), matching `src/lib/server/email/resend.ts` — `npm run build` imports every `+server.ts` to detect its exported HTTP methods, so an import-time secret check would make the build itself require a real credential.

```bash
cat src/lib/server/webhooks/svix.ts
```

```output
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
```

```bash
cat src/routes/api/webhooks/resend-inbound/+server.ts
```

```output
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
```

## Verification against the live endpoint

`src/lib/server/webhooks/verify-inbound-webhook.mts` drives the real running endpoint with five request shapes. It uses the `svix` library's own `sign()` to produce genuinely-signed requests, so the positive case proves verification actually succeeds rather than just that the route exists.

The block below is self-contained: it generates a throwaway signing secret, starts a dev server with that secret in its environment, runs the five checks, and stops the server — no dependency on the gitignored `.env`.

```bash
set -e
export RESEND_INBOUND_WEBHOOK_SECRET="whsec_dGVzdC1zZWNyZXQtZm9yLXVzLWUwMS1kZW1v"
export WEBHOOK_BASE_URL="http://localhost:5199"
npm run dev -- --port 5199 >/tmp/us-e01-dev.log 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null" EXIT
for i in $(seq 1 60); do curl -sf -o /dev/null "$WEBHOOK_BASE_URL/login" && break; sleep 1; done
npx tsx src/lib/server/webhooks/verify-inbound-webhook.mts
```

```output
PASS  valid signature -> 200 (expected 200)
PASS  tampered body, original signature -> 401 (expected 401)
PASS  signature from a different secret -> 401 (expected 401)
PASS  no svix headers -> 401 (expected 401)
PASS  missing svix-id header -> 401 (expected 401)

All webhook signature checks passed
```

The tampered-body case is the important one: it reuses a **genuine** signature over mutated bytes and is still rejected, which is what proves the signature is checked against the raw body rather than a re-serialized parse.

## Quality checks

```bash
npm run check 2>&1 | grep -oE "[0-9]+ ERRORS [0-9]+ WARNINGS [0-9]+ FILES_WITH_PROBLEMS"
```

```output
0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```

```bash
npm run lint 2>&1 | grep -vE "^$|^>"
```

```output
Checking formatting...
All matched files use Prettier code style!
```

```bash
npm run build >/dev/null 2>&1 && echo "build OK"
```

```output
build OK
```

## Outstanding manual step

`RESEND_INBOUND_WEBHOOK_SECRET` is documented in `.env.example`; the real value comes from the Resend dashboard's webhook config (`whsec_…`) once the inbound webhook URL is registered against the deployed `/api/webhooks/resend-inbound`. That registration, and adding the var to Vercel project settings, is a project-owner step — same pattern as the Turso/R2/Resend credentials in US-A01/A02/B02.

## Post-merge: verified against production

The self-contained block above proves the verification logic on a throwaway
secret and a local dev server. Recorded separately here (as prose, not an
executable block, since it depends on the gitignored `.env` and a live
deployment — an `exec` block would make `showboat verify` fail for anyone
lacking both) is the same five-case suite run against the real deployment at
`https://mail.caseynazelrod.com`, with the genuine `whsec_…` secret from the
Resend dashboard in both `.env` and Vercel project settings:

    WEBHOOK_BASE_URL=https://mail.caseynazelrod.com \
      node --env-file=.env node_modules/.bin/tsx \
      src/lib/server/webhooks/verify-inbound-webhook.mts

    PASS  valid signature -> 200 (expected 200)
    PASS  tampered body, original signature -> 401 (expected 401)
    PASS  signature from a different secret -> 401 (expected 401)
    PASS  no svix headers -> 401 (expected 401)
    PASS  missing svix-id header -> 401 (expected 401)

    All webhook signature checks passed

The `valid signature -> 200` case is what the local run cannot establish: it
passes only if the secret held by Vercel and the secret used to sign are the
same value. A first attempt failed here on a mistyped secret, which is the
failure this case exists to catch.

Note on DNS: the app is served from the `mail.` subdomain while Resend owns
`send.`, `links.`, and the apex MX for receiving — so **inbound addresses are
on the apex** (`something@caseynazelrod.com`), not `@mail.`. The two never
collide, but had the app and the receiving MX shared one name, a CNAME to
Vercel would have blocked the MX records outright (a CNAME must be the only
record at its name).

### Superseding the outstanding manual step above

The registration step listed in the previous section is **done**: the webhook is
registered in the Resend dashboard against
`POST https://mail.caseynazelrod.com/api/webhooks/resend-inbound` for the
inbound email event, and `RESEND_INBOUND_WEBHOOK_SECRET` is set in Vercel.

One gap remains, and it is not something this story's tests can close: every
check above is this repo's own signing code talking to its own endpoint. That a
real Resend delivery arrives and verifies — i.e. that the apex MX is receiving
and that Resend's signature format matches `svix`'s in practice — is confirmed
only by sending a real email and observing a 200 in the Vercel function logs.
US-E02 should capture that first real payload before writing a parser against
assumed field shapes; the stand-in object in
`verify-inbound-webhook.mts` (`{ type, data: { from, subject } }`) is a
placeholder, not observed truth.

Also carried into US-E02: a genuine `svix-id` replayed inside the Svix
timestamp tolerance verifies twice. Ingestion needs an idempotency key (the
`svix-id` or Resend's message id) or a provider retry will duplicate a thread.
