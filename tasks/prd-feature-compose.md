# PRD: Feature — Compose, Reply, Forward

## Introduction

Outbound email creation: new messages, replies, and forwards, sent via the Resend send API, with attachment support.

## Goals

- Send new emails, replies, and forwards from a single compose interface
- Support file attachments on outbound mail, stored in R2 and delivered via Resend
- Correctly set threading headers so replies stay grouped in-thread on both ends

## User Stories

### US-H01: Compose new email UI
**Description:** As the app owner, I want a compose screen to write a brand-new email, so I can start conversations, not just reply to inbound ones.

**Acceptance Criteria:**
- [ ] `/compose` renders To, Cc (optional, collapsible), Subject, and body fields
- [ ] To field supports typing an address directly or selecting from existing contacts (autocomplete)
- [ ] Body field supports plain text at minimum; rich text/HTML composition is acceptable if using a lightweight editor, but plain text must always work
- [ ] Client-side validation requires at least one To address and a non-empty subject or body before allowing send
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-H02: Send outbound email via Resend
**Description:** As the app owner, I want clicking Send to actually deliver my email, so composing is functional, not just a form.

**Acceptance Criteria:**
- [ ] Form action calls the Resend send API with from/to/cc/subject/body
- [ ] On success, a new `emails` row is inserted with `direction = 'outbound'`, `is_read = true`, and either a new `threads` row (new message) or the existing thread's ID (reply/forward)
- [ ] On Resend API failure, the user sees an inline error and the compose form retains their input (no data loss)
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-H03: Reply pre-fills context and threading headers
**Description:** As the app owner, I want "Reply" to pre-fill the recipient and subject and stay correctly threaded, so replying is fast and the conversation doesn't fork.

**Acceptance Criteria:**
- [ ] Navigating from a message's "Reply" action opens `/compose` pre-filled with To = original sender, Subject = "Re: " + original subject (not double-prefixed if already present)
- [ ] The sent email's `In-Reply-To` and threading is set so it lands in the same `thread_id` as the original message
- [ ] Quoted original message content is included below the compose body, visually separated (e.g., "On [date], [sender] wrote:" + indented quote)
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-H04: Forward pre-fills subject and body, clears recipient
**Description:** As the app owner, I want "Forward" to carry over the original content but let me pick a new recipient, so I can share a message with someone else.

**Acceptance Criteria:**
- [ ] Navigating from a message's "Forward" action opens `/compose` with an empty To field, Subject = "Fwd: " + original subject (not double-prefixed if already present), and the original body quoted in the compose area
- [ ] Forwarded messages start a decision point: forwarding creates a new thread (since the recipient is new), not appended to the original thread
- [ ] Original attachments are carried over as attachments on the forwarded send (re-associated in R2/`attachments`, not re-uploaded by the user)
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-H05: Attach files when composing
**Description:** As the app owner, I want to attach files to an email I'm writing, so I can send documents/images to people.

**Acceptance Criteria:**
- [ ] Compose UI has a file picker/drag-drop area supporting multiple files
- [ ] Selected files are uploaded to R2 before/at send time and passed to the Resend send API as attachments
- [ ] Attached files list shows filename/size with a remove option before sending
- [ ] A sensible size limit (e.g., total attachments under ~25MB, matching common email provider limits) is enforced client- and server-side with a clear error if exceeded
- [ ] On successful send, `attachments` rows are created against the new `emails` row
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: All outbound sends go through the Resend send API using the app's configured sending domain/address.
- FR-2: Replies must set proper `In-Reply-To`/`References` headers via the Resend API so both this app's threading and the recipient's mail client thread correctly.
- FR-3: Forwarded messages must reuse existing attachment objects in R2 rather than requiring re-upload.
- FR-4: Send failures must never silently drop the user's composed content — the form must preserve state and surface a retry path.
- FR-5: Contacts are upserted (per Data Model PRD) for every new recipient address used in a sent email.

## Non-Goals

- No scheduled send / send-later in v1.
- No drafts auto-save/persistence across sessions in v1 (a lost compose-in-progress on navigation away is acceptable for v1; draft persistence is a fast-follow).
- No CC/BCC-based mailing-list style sends — single conversation semantics only.

## Design Considerations

- Compose screen follows the same Dusk Terminal surface/border treatment as the rest of the app; the Subject/To fields use the monospace font for addresses (matching the "metadata is monospace" signature detail), body text uses the humanist sans.
- Send button uses the primary accent color (`#7FB4A6`); destructive actions (discard/remove attachment) use the dusty-rose danger color (`#C97F7F`).

## Success Metrics

- A composed email with one attachment is delivered and visible in the recipient's inbox (verified manually against a real external address) within normal Resend delivery latency.
- Reply threading verified end-to-end: a reply sent from this app appears correctly nested in a real third-party mail client (e.g., Gmail) thread view.

## Open Questions

- Should there be a plain-text-only fallback body always generated alongside any HTML compose content, for recipients on text-only clients? (Assumption: yes, generate a plain-text version from the HTML/rich content automatically at send time.)
