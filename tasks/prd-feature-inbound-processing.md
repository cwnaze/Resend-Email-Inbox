# PRD: Feature — Inbound Email Processing

## Introduction

Handles Resend's inbound webhook: verifying the request, parsing the payload, sanitizing HTML, uploading attachments to R2, and persisting threads/emails/contacts/attachments to Turso.

## Goals

- Reliably ingest every inbound email delivered to the single configured address
- Never persist a payload that fails signature verification
- Correctly thread replies into existing conversations using Message-ID/In-Reply-To headers
- Sanitize all HTML before storage

## User Stories

### US-E01: Verify Resend inbound webhook signature
**Description:** As a developer, I need every inbound webhook request cryptographically verified, so unauthenticated payloads can never be ingested.

**Acceptance Criteria:**
- [ ] `POST /api/webhooks/resend-inbound` reads `svix-id`, `svix-timestamp`, `svix-signature` headers
- [ ] Uses the `svix` library and `RESEND_INBOUND_WEBHOOK_SECRET` to verify the raw request body
- [ ] Requests failing verification return `401` and are not parsed further or persisted
- [ ] Typecheck passes

### US-E02: Parse inbound payload and upsert contact
**Description:** As the app owner, I want every inbound sender automatically added to my contacts, so I don't have to add people manually.

**Acceptance Criteria:**
- [ ] Verified payload is parsed into from/to/cc/subject/body/date/Message-ID/In-Reply-To fields
- [ ] A `contacts` row is upserted by `email` (case-insensitive); if new, `name` is set from the payload's display name and `auto_created = true`
- [ ] If a contact already exists and was manually edited (`auto_created = false`), its `name` is not overwritten
- [ ] Typecheck passes

### US-E03: Sanitize HTML body and store email
**Description:** As the app owner, I want inbound HTML sanitized before it's stored, so no malicious markup ever reaches my browser.

**Acceptance Criteria:**
- [ ] `body_html` is run through `isomorphic-dompurify` stripping scripts, event handlers, and disallowed remote-loading tags before being persisted
- [ ] `body_text` (plain-text alternative) is stored as-is if present in the payload
- [ ] Duplicate deliveries (same `message_id` already in `emails`) are detected and skipped (idempotent ingestion) rather than erroring
- [ ] Typecheck passes

### US-E04: Thread assignment
**Description:** As the app owner, I want replies grouped with their original conversation, so I see a coherent thread instead of scattered messages.

**Acceptance Criteria:**
- [ ] If the payload's `In-Reply-To` matches an existing `emails.message_id`, the new email is attached to that email's `thread_id`
- [ ] If no match is found, a new `threads` row is created with the (normalized) subject
- [ ] `threads.last_message_at` and `threads.is_read` are updated per the rules in the Data Model PRD
- [ ] Typecheck passes

### US-E05: Attachment extraction and R2 upload
**Description:** As the app owner, I want inbound attachments saved and accessible from the thread view, so I don't lose files sent to me.

**Acceptance Criteria:**
- [ ] Each attachment in the payload (base64-encoded) is decoded and uploaded to R2 under a key namespaced by email ID
- [ ] An `attachments` row is created per file with filename, content-type, size, R2 key, and public URL
- [ ] Ingestion completes successfully even if one attachment upload fails, logging the failure without discarding the rest of the email (attachment marked with a retry-later state is out of scope for v1 — failed attachments are simply omitted and logged)
- [ ] Typecheck passes

## Functional Requirements

- FR-1: The webhook endpoint must reject any request without valid Svix signature headers before any parsing occurs.
- FR-2: Ingestion must be idempotent on `message_id` — replays/retries never create duplicate email rows.
- FR-3: All HTML must pass through DOMPurify before being written to `emails.body_html`.
- FR-4: Threading must use `In-Reply-To`/`Message-ID` header matching as the primary strategy; if absent, fall back to grouping by normalized subject within a reasonable time window (e.g., same normalized subject within 30 days) as a best-effort secondary strategy.
- FR-5: Attachment bytes must be streamed/uploaded to R2 and never written to the `emails` or `attachments` table body.

## Non-Goals

- No virus/malware scanning of attachments in v1.
- No support for calendar invites (.ics) beyond storing them as a generic attachment.
- No inline-image (`cid:`) rewriting to R2 URLs in v1 — inline images render as regular attachments if not resolvable; full `cid:` rewriting is a fast-follow.

## Technical Considerations

- Resend's inbound payload delivers attachments base64-inline in the JSON body; the handler must decode and stream to R2 promptly to stay within serverless memory/time limits (see Architecture PRD).
- Webhook processing should acknowledge receipt (200) only after successful persistence, so Resend's retry behavior can recover from transient failures; verification failures return 401 as noted above (not retried, since retrying a bad signature is pointless).

## Success Metrics

- 100% of test emails sent to the configured address (including one with an attachment and one plain-text-only) appear correctly threaded and sanitized within 10 seconds.
- Zero duplicate email rows created when Resend redelivers the same webhook event (simulated in testing).

## Open Questions

- Should failed attachment uploads trigger a retry job, or is best-effort logging sufficient for v1? (Assumption: best-effort logging is sufficient at single-user scale; revisit if attachment loss becomes a real problem.)
