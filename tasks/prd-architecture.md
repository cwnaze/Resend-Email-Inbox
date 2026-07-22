# PRD: Architecture — Custom Email Inbox

## Introduction

Defines the technical foundation: routing structure, hosting/runtime constraints, mail transport integration, database choice, and secrets management. This PRD resolves the "key questions" flagged in the project brief.

## Goals

- Choose a database that works within Vercel's serverless model, requires no persistent server, and is cheap/free at single-user scale
- Define a clear SvelteKit route structure separating public (login) and protected (mailbox) areas
- Specify exactly how inbound and outbound Resend integration works, including webhook signature verification
- Specify attachment storage that doesn't hit serverless payload/response-size limits
- Document all required environment variables and secrets

## Decisions (resolving the brief's open questions)

### Database: **Turso (libSQL) + Drizzle ORM**

**Recommendation and justification:**
- Turso is a distributed SQLite (libSQL) platform with an HTTP-based driver, purpose-built for serverless/edge runtimes — no connection pooling problems on Vercel's short-lived function invocations.
- A single Turso database holds every table this app needs (emails, threads, contacts, attachments metadata, auth codes, sessions) — no need for a second datastore.
- Drizzle ORM's `drizzle-orm/libsql` driver gives first-class TypeScript types and straightforward migration files that map 1:1 to the Data Model PRD, with negligible cold-start overhead.
- SQLite's simpler concurrency model is a non-issue at single-user scale, and Turso's embedded replicas / edge read replicas are available later if latency becomes a concern.

### Attachment Storage: **Cloudflare R2**

- Inbound attachments (parsed from Resend webhook payloads, base64-encoded) and outbound compose attachments are uploaded to Cloudflare R2 as binary objects via the S3-compatible API (`@aws-sdk/client-s3` pointed at the R2 endpoint, or the R2 SDK).
- Only attachment **metadata** (filename, content-type, size, R2 object key/URL, associated email ID) is stored in Turso — never raw bytes in the DB. This keeps DB rows small and avoids serverless function response-size limits when listing emails.
- R2 is chosen over Vercel Blob for zero egress fees and to keep storage decoupled from the hosting platform.

### Inbound Webhook Verification

- Resend signs inbound webhook payloads using **Svix** headers (`svix-id`, `svix-timestamp`, `svix-signature`).
- The webhook route verifies every incoming request using the `svix` npm package and the webhook signing secret provided by Resend's dashboard, **before** parsing or persisting any payload content.
- Requests that fail verification are rejected with `401` and never touch the database.

### HTML Email Rendering & Sanitization

- Inbound HTML bodies are sanitized server-side at ingestion time using `isomorphic-dompurify`, stripping `<script>`, event handlers, and disallowing remote-loading tags outside of `<img>`.
- Sanitized HTML is stored as-is (already safe) rather than re-sanitizing on every read, to save serverless compute.
- On render, sanitized HTML is displayed inside a sandboxed `<iframe srcdoc>` with `sandbox="allow-same-origin"` (no `allow-scripts`) as defense-in-depth, plus a `referrerpolicy="no-referrer"` to avoid leaking data to remote image trackers.
- Remote images are proxied or blocked-by-default with a "Load images" click-to-reveal action per email, to prevent tracking-pixel-based read receipts (privacy-friendly default).

## Route Structure (SvelteKit)

```
src/routes/
  +layout.svelte              # global shell, theme
  +layout.server.ts           # session check, redirects
  login/
    +page.svelte              # single "Send me a code" button
    +page.server.ts            # form action: request code, verify code
  (app)/                       # protected route group
    +layout.server.ts          # enforces authenticated session, else redirect to /login
    inbox/
      +page.svelte             # inbox list view
      +page.server.ts          # load threads
      [threadId]/
        +page.svelte           # thread/detail view
        +page.server.ts        # load thread + messages
    compose/
      +page.svelte             # compose new / reply / forward
      +page.server.ts          # send action
    contacts/
      +page.svelte
      +page.server.ts
  api/
    webhooks/
      resend-inbound/
        +server.ts             # POST endpoint, Svix-verified, ingests inbound mail
    auth/
      request-code/+server.ts  # POST, rate-limited, sends code
      verify-code/+server.ts   # POST, verifies code, sets session cookie
      logout/+server.ts        # POST, clears session
```

## Serverless Constraints Accounted For

- Vercel serverless functions have a max execution duration (10s Hobby / configurable on Pro) — the inbound webhook handler must parse, sanitize, and persist within this window; large attachments are streamed directly to R2 rather than buffered fully in memory where avoidable.
- Request/response body size limits (4.5MB default on Vercel) mean large attachments from Resend's webhook (which sends attachments base64-inline) are decoded and immediately streamed out to R2 rather than held in a response payload.
- No persistent local filesystem — all state lives in Turso + R2, nothing is written to disk between invocations.
- Turso is accessed via its HTTP-based libSQL client (`@libsql/client`), which is stateless per-request and has no connection-pool exhaustion risk on serverless.

## Environment Variables / Secrets

| Variable | Purpose |
|---|---|
| `TURSO_DATABASE_URL` | Turso libSQL database URL |
| `TURSO_AUTH_TOKEN` | Turso database auth token |
| `RESEND_API_KEY` | Outbound send + Resend account access |
| `RESEND_INBOUND_WEBHOOK_SECRET` | Svix signing secret to verify inbound webhook requests |
| `R2_ACCOUNT_ID` | Cloudflare account ID for R2 |
| `R2_ACCESS_KEY_ID` | R2 S3-compatible API access key |
| `R2_SECRET_ACCESS_KEY` | R2 S3-compatible API secret key |
| `R2_BUCKET_NAME` | R2 bucket used for attachment storage (private; no public URL base — download links are presigned on demand) |
| `AUTH_RECIPIENT_EMAIL` | Hardcoded constant: `cwnaze@gmail.com` — the only address login codes are ever sent to |
| `AUTH_SENDER_EMAIL` | `auth@caseynazelrod.com` — the Resend-verified sending address for auth codes |
| `SESSION_SECRET` | Signing key for session cookie (e.g., used with a signed-cookie or JWT library) |

## User Stories

### US-A00: Scaffold SvelteKit project with Tailwind CSS and Vercel adapter
**Description:** As a developer, I need a working SvelteKit project with Tailwind CSS and the Vercel adapter installed, so every later story has a real app to build inside.

**Acceptance Criteria:**
- [ ] SvelteKit project created with TypeScript, using Svelte 5 (runes enabled)
- [ ] Tailwind CSS installed and configured (postcss/tailwind config present, imported in the root layout)
- [ ] `@sveltejs/adapter-vercel` installed and set as the adapter in `svelte.config.js`
- [ ] `npm run dev` starts successfully and renders a default placeholder page
- [ ] `npm run build` completes successfully with the Vercel adapter
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-A01: Provision Turso database and Drizzle schema scaffold
**Description:** As a developer, I need the database provisioned and connected so all later features have persistence to build on.

**Acceptance Criteria:**
- [ ] Turso database created and `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` available locally via `.env` and in Vercel project settings
- [ ] Drizzle ORM installed and configured with `drizzle-orm/libsql` and a `drizzle.config.ts` pointing at the Turso instance
- [ ] `npm run db:push` (or equivalent) successfully applies an empty baseline schema
- [ ] Typecheck/lint passes

### US-A02: Provision Cloudflare R2 for attachment storage
**Description:** As a developer, I need object storage wired up so attachments have somewhere to live outside the database.

**Acceptance Criteria:**
- [ ] Cloudflare R2 bucket created (private, no public access/custom domain); `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` available locally and in Vercel project settings
- [ ] A small utility function exists that uploads a `Buffer`/`Blob` to R2 (via the S3-compatible API) and returns its object key
- [ ] A small utility function exists that generates a time-limited presigned GET URL for a given object key
- [ ] A small utility function exists that deletes an R2 object by key
- [ ] Typecheck/lint passes

### US-A03: Scaffold protected route group and session-check layout
**Description:** As a developer, I need the `(app)` route group to redirect unauthenticated visitors to `/login`, so every mailbox feature is protected from day one.

**Acceptance Criteria:**
- [ ] `src/routes/(app)/+layout.server.ts` checks for a valid session cookie and redirects to `/login` if absent/invalid
- [ ] `src/routes/login/+page.svelte` renders a placeholder page (full auth UI built in the Auth PRD)
- [ ] Visiting `/inbox` while unauthenticated redirects to `/login`
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: The system must use Turso (libSQL) as the sole relational datastore for all persisted entities.
- FR-2: The system must use Cloudflare R2 for all binary attachment storage; attachment bytes must never be stored in Turso.
- FR-3: The system must verify Svix signatures on every request to the inbound webhook route before processing the payload.
- FR-4: The system must sanitize all inbound HTML email bodies with DOMPurify before storage.
- FR-5: The system must render sanitized HTML bodies inside a sandboxed iframe without script execution.
- FR-6: The system must block remote image loading by default in the thread view, with an explicit per-email opt-in to load them.
- FR-7: All routes under `(app)` must require a valid authenticated session.
- FR-8: All secrets must be read from environment variables; none may be hardcoded in source except the two intentionally-constant auth email addresses, which are documented as such.

## Technical Considerations

- Drizzle migrations are checked into version control under `drizzle/` for reproducibility.
- The Resend inbound webhook URL must be registered in the Resend dashboard pointing at the deployed `/api/webhooks/resend-inbound` endpoint; local development uses a tool like `resend-cli` or a tunneling service (e.g., ngrok) for testing, documented in a README but not built as app functionality.

## Success Metrics

- Cold-start webhook processing (verify → sanitize → persist, excluding attachment upload) completes in under 3 seconds for a typical text/HTML email with no attachments.
- Zero payloads are persisted without passing Svix verification, confirmed via a deliberate bad-signature test.

## Open Questions

- Should the app support a secondary "read replica" or caching layer if inbox size grows very large? (Assumption: not needed at single-user scale; revisit if the mailbox exceeds tens of thousands of messages.)
- Should R2 attachments have an expiry/lifecycle policy, or persist indefinitely? (Assumption: persist indefinitely, matching mailbox semantics.)
