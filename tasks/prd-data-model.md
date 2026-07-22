# PRD: Data Model — Custom Email Inbox

## Introduction

Defines the Turso (libSQL) schema, via Drizzle ORM, for every persisted entity: threads, emails, attachments, contacts, auth codes, and sessions.

## Goals

- One coherent schema that supports threading, read/unread state, attachments, and contacts
- Schema supports the single fixed inbound address (no multi-tenant columns)
- Auth codes and sessions live in the same database as mailbox data (per Architecture PRD)

## Entities

### `contacts`
| Column | Type | Notes |
|---|---|---|
| `id` | text (uuid), PK | |
| `email` | text, unique, not null | |
| `name` | text, nullable | display name, editable |
| `auto_created` | integer (bool), not null, default true | false once manually edited/confirmed |
| `created_at` | integer (unix ms), not null | |
| `updated_at` | integer (unix ms), not null | |

### `threads`
| Column | Type | Notes |
|---|---|---|
| `id` | text (uuid), PK | |
| `subject` | text, not null | normalized subject (e.g., "Re:" stripped for grouping) |
| `last_message_at` | integer (unix ms), not null | for sort order |
| `is_read` | integer (bool), not null, default false | true only if every message in thread is read |
| `created_at` | integer (unix ms), not null | |

### `emails`
| Column | Type | Notes |
|---|---|---|
| `id` | text (uuid), PK | |
| `thread_id` | text, FK → `threads.id`, not null | |
| `message_id` | text, unique, not null | RFC Message-ID header, for threading/dedup |
| `in_reply_to` | text, nullable | Message-ID this replies to, if any |
| `direction` | text ('inbound' \| 'outbound'), not null | |
| `from_email` | text, not null | |
| `from_name` | text, nullable | |
| `to_emails` | text (JSON array), not null | |
| `cc_emails` | text (JSON array), nullable | |
| `bcc_emails` | text (JSON array), nullable | |
| `subject` | text, not null | |
| `body_text` | text, nullable | plain-text body |
| `body_html` | text, nullable | sanitized HTML body (post-DOMPurify) |
| `is_read` | integer (bool), not null, default false | inbound only meaningfully false initially; outbound defaults true |
| `is_deleted` | integer (bool), not null, default false | soft delete |
| `received_at` | integer (unix ms), not null | Date header value or send timestamp |
| `created_at` | integer (unix ms), not null | row insert time |

### `attachments`
| Column | Type | Notes |
|---|---|---|
| `id` | text (uuid), PK | |
| `email_id` | text, FK → `emails.id`, not null | |
| `filename` | text, not null | |
| `content_type` | text, not null | |
| `size_bytes` | integer, not null | |
| `r2_object_key` | text, not null | key within the R2 bucket |
| `r2_public_url` | text, not null | |
| `created_at` | integer (unix ms), not null | |

### `auth_codes`
| Column | Type | Notes |
|---|---|---|
| `id` | text (uuid), PK | |
| `code_hash` | text, not null | SHA-256 of the 6-digit code |
| `created_at` | integer (unix ms), not null | |
| `expires_at` | integer (unix ms), not null | `created_at` + 10 min |
| `used_at` | integer (unix ms), nullable | set on successful verification |
| `attempt_count` | integer, not null, default 0 | failed verify attempts against this code |

### `sessions`
| Column | Type | Notes |
|---|---|---|
| `id` | text (uuid), PK | |
| `token_hash` | text, not null | SHA-256 of the raw session token stored in the cookie |
| `created_at` | integer (unix ms), not null | |
| `expires_at` | integer (unix ms), not null | sliding expiration, updated on activity |

## Indexes

- `emails.thread_id` (lookups when rendering a thread)
- `emails.message_id` (unique, dedup on inbound ingestion)
- `emails.is_read` + `emails.is_deleted` (inbox list filtering)
- `threads.last_message_at` (inbox sort order)
- `contacts.email` (unique, dedup on ingestion)
- `attachments.email_id`
- `sessions.token_hash` (unique)
- `auth_codes.expires_at` (cleanup queries)

## User Stories

### US-D01: Define and migrate core schema
**Description:** As a developer, I need the tables above defined in Drizzle so every feature has a schema to build against.

**Acceptance Criteria:**
- [ ] Drizzle schema file(s) define `contacts`, `threads`, `emails`, `attachments`, `auth_codes`, `sessions` exactly per the tables above
- [ ] All specified indexes are created
- [ ] Foreign keys (`emails.thread_id`, `attachments.email_id`) are enforced
- [ ] Migration applies cleanly against a fresh Turso database
- [ ] Typecheck passes

## Functional Requirements

- FR-1: `emails.message_id` must be unique to prevent duplicate ingestion if Resend retries a webhook delivery.
- FR-2: A thread's `is_read` must be derived/updated to false whenever a new unread inbound email is added to it, and recomputed to true only when every email in the thread is read.
- FR-3: Soft-deleted emails (`is_deleted = true`) must be excluded from default inbox/thread queries but retained in the database (no hard delete in v1).
- FR-4: Contact rows are upserted (by `email`, case-insensitive) whenever an email is sent or received involving a new address; `auto_created` flips to false once a user manually edits that contact.

## Non-Goals

- No full schema support for multiple inbound addresses/mailboxes (single mailbox assumed throughout, per Overview PRD).
- No hard-delete/purge feature in v1 — emails marked deleted are hidden, not destroyed.

## Technical Considerations

- SQLite/libSQL has no native boolean or JSON type; booleans are stored as `integer` (0/1) and address lists as JSON-encoded text columns, consistent with Drizzle's SQLite dialect conventions.
- Timestamps are stored as unix milliseconds (integer) for simple sorting and comparison.

## Success Metrics

- Schema supports rendering the full inbox list and any thread in a single query each (no N+1 query patterns needed for the common paths).

## Open Questions

- Should `threads.subject` normalization (stripping "Re:"/"Fwd:") happen at write time or query time? (Assumption: write time, computed once during inbound/outbound processing, for simpler read queries.)
