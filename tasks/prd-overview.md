# PRD: Overview — Custom Email Inbox

## Introduction

A custom, single-user email inbox web application. It replaces a generic webmail client with a purpose-built, minimal reading and composing environment for one person's mailbox, built on Svelte 5 + SvelteKit, using Resend for both inbound and outbound email, deployed on Vercel.

This PRD is the umbrella document. Detailed requirements live in companion PRDs: Architecture, Auth, Data Model, UI/UX, and one per feature (Inbox List, Thread View, Compose, Inbound Processing, Contacts).

## Goals

- Provide a fast, calm, distraction-free interface for reading and replying to email
- Receive inbound mail via Resend webhooks and persist it durably
- Send, reply to, and forward mail via the Resend send API
- Restrict access to a single authorized user via a one-button, code-based login (no password, no email-entry field, no signup)
- Run entirely on Vercel's serverless platform within its constraints (execution time, payload size, no persistent filesystem)

## Non-Goals

- **No multi-user support.** This is not a SaaS product; there is exactly one authorized user and one mailbox.
- No public signup or account creation flow of any kind.
- No email-entry field at login — the destination for auth codes is a fixed server-side constant, never user input.
- No support for connecting third-party mailboxes (Gmail, Outlook, IMAP/POP3, etc.) — Resend is the only mail transport.
- No calendaring, tasks, or contacts sync with external services (e.g., no Google Contacts import) in v1.
- No mobile native app — responsive web only.
- No end-to-end encryption of stored mail content in v1 (standard at-rest DB encryption from the hosting provider is sufficient).
- No multiple inbound aliases/addresses in v1 — single fixed receiving address only (see Architecture PRD).
- No full-text search over email body in v1 — search covers subject and sender only (see Inbox List Feature PRD).

## Target User

A single individual (the app owner) who wants a personal, aesthetically considered inbox for one email address, accessed from desktop and mobile browsers.

## Success Metrics

- Inbound email sent to the configured address appears in the inbox UI within 10 seconds of Resend's webhook firing
- Login (button click → code entry → authenticated session) completes in under 60 seconds end-to-end for the legitimate user
- Zero unauthorized sessions created (rate limiting and single-use code enforcement hold under manual adversarial testing)
- Application remains fully usable on a phone-width viewport (375px) with no horizontal scrolling

## Open Questions

- Should there be a way to export/download the full mailbox (e.g., as .eml files) for backup, or is DB durability considered sufficient? (Assumption: out of scope for v1; DB backups suffice.)
- Should read receipts or "email opened" tracking pixels be generated for outbound mail? (Assumption: no — not requested, adds complexity and privacy concerns.)

## Companion PRDs

1. `prd-architecture.md`
2. `prd-auth.md`
3. `prd-data-model.md`
4. `prd-feature-inbox-list.md`
5. `prd-feature-thread-view.md`
6. `prd-feature-compose.md`
7. `prd-feature-inbound-processing.md`
8. `prd-feature-contacts.md`
9. `prd-ui-ux.md`

## Proposed Build Order

See the "Proposed Build Order" section at the end of `prd-ui-ux.md` for the full cross-PRD sequencing rationale. Summary: schema → auth → inbound processing → inbox list → thread view → compose/outbound → contacts → search/polish.
