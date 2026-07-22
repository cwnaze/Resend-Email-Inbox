# PRD: Feature — Email Detail / Thread View

## Introduction

The reading view for a single conversation: all messages in a thread, rendered chronologically, with sanitized HTML display, attachment access, and entry points into reply/forward.

## Goals

- Comfortable, distraction-free reading experience for a full thread
- Safe rendering of HTML email bodies
- Clear access to attachments and to the reply/forward actions (built out fully in the Compose PRD)

## User Stories

### US-G01: Load and render a full thread
**Description:** As the app owner, I want to open a thread and see every message in it in order, so I have full context on the conversation.

**Acceptance Criteria:**
- [ ] `/inbox/[threadId]` server load fetches the thread and all non-deleted member emails ordered by `received_at` ascending
- [ ] Each message shows sender, recipients (to/cc), timestamp, and body
- [ ] A 404/empty state is shown if the thread ID doesn't exist or has no visible messages
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-G02: Sanitized HTML rendering with image opt-in
**Description:** As the app owner, I want HTML emails to render safely and without loading remote trackers automatically, so I stay protected from malicious or tracking content.

**Acceptance Criteria:**
- [ ] `body_html` renders inside a sandboxed `<iframe srcdoc>` (`sandbox="allow-same-origin"`, no `allow-scripts`) sized to content height
- [ ] Remote `<img>` tags are blocked by default (e.g., stripped `src` replaced with a placeholder) with a per-message "Load images" button that reveals them on click
- [ ] Messages with only `body_text` render as preformatted, wrapped plain text with no iframe needed
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-G03: Attachment list and download
**Description:** As the app owner, I want to see and download attachments on a message, so I can access files people send me.

**Acceptance Criteria:**
- [ ] Each message with attachments shows a list of filename + size below the body
- [ ] Clicking an attachment opens/downloads it from its R2 public URL
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-G04: Mark read on view, soft-delete a message
**Description:** As the app owner, I want opening a thread to mark it read, and I want to delete a message I don't need, so my inbox stays current.

**Acceptance Criteria:**
- [ ] Loading the thread page marks all its emails `is_read = true` if not already, and recomputes `threads.is_read`
- [ ] A delete action on an individual message sets `is_deleted = true` (soft delete); the message disappears from the thread view but is not destroyed
- [ ] Deleting the last visible message in a thread returns the user to `/inbox`
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: Thread view must render messages in chronological order by `received_at`.
- FR-2: HTML rendering must never execute inline or remote scripts, per the Architecture PRD's sandboxing requirements.
- FR-3: Remote images must be opt-in per message, not globally toggled once for the whole app.
- FR-4: Delete is soft (sets `is_deleted`), never a hard row delete, consistent with the Data Model PRD.
- FR-5: Reply/Forward buttons on each message navigate to `/compose` pre-populated with the appropriate context (built out in the Compose PRD).

## Non-Goals

- No inline message editing (drafts) in v1 beyond the Compose feature's own draft handling.
- No print-friendly view in v1.
- No message-level starring/flagging in v1.

## Design Considerations

- Reading measure (line length) constrained to a comfortable column width (e.g., max ~72ch) with generous line-height, per the Dusk Terminal type direction.
- Sender/timestamp metadata rendered in monospace, body text in the humanist sans, matching the signature style detail.
- Thin 1px dividers between messages in a thread; no drop shadows.

## Success Metrics

- A thread with 10+ messages and one attachment loads and is fully readable in under 1 second on a typical connection.

## Open Questions

- Should quoted "on [date], [sender] wrote:" reply chains embedded in HTML bodies be collapsed/truncated by default? (Assumption: yes, collapse quoted history behind a "Show quoted text" toggle if a quote block is detected, to keep the primary reading view uncluttered — implemented as a best-effort heuristic, not required to be perfect in v1.)
