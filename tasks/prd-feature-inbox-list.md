# PRD: Feature — Inbox List View

## Introduction

The primary landing view after login: a list of threads, sorted by recency, with read/unread indication, search by subject/sender, and read-state filtering.

## Goals

- At-a-glance scan of recent conversations with clear unread indication
- Fast subject/sender search
- Filter by read/unread

## User Stories

### US-F01: Load and render thread list
**Description:** As the app owner, I want to see all my threads sorted by most recent activity, so the newest conversations are always on top.

**Acceptance Criteria:**
- [ ] `/inbox` server load queries `threads` ordered by `last_message_at` descending, joined to each thread's latest email for preview (from, subject, snippet, timestamp)
- [ ] Each row shows sender name/email, subject, a short body snippet, and relative timestamp (e.g., "2h ago")
- [ ] Soft-deleted-only threads (all member emails deleted) are excluded from the list
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-F02: Unread visual treatment
**Description:** As the app owner, I want unread threads to visually stand out, so I know what I haven't looked at yet.

**Acceptance Criteria:**
- [ ] Unread threads show a sage accent dot (`#7FB4A6`) and slightly brighter primary-text weight
- [ ] Read threads render in the muted text tone
- [ ] Opening a thread marks all its emails `is_read = true` and recomputes `threads.is_read`
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-F03: Read/unread filter
**Description:** As the app owner, I want to filter the list to only unread threads, so I can focus on what's new.

**Acceptance Criteria:**
- [ ] Filter control offers All / Unread / Read
- [ ] Filter state is reflected in the URL query params (e.g., `?filter=unread`) so it survives refresh/back navigation
- [ ] Selecting "Unread" hides threads where `threads.is_read = true`
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-F04: Subject/sender search
**Description:** As the app owner, I want to search my inbox by subject or sender, so I can quickly find a specific conversation.

**Acceptance Criteria:**
- [ ] A search input filters the visible thread list by case-insensitive substring match against thread subject or any member email's `from_name`/`from_email`
- [ ] Search query is reflected in the URL query params (e.g., `?q=invoice`)
- [ ] Empty result state shows a clear "No matching threads" message
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: The inbox list must load in a single query per page (no per-row N+1 queries) for reasonable inbox sizes.
- FR-2: Search must run server-side (via the load function or a form action) against `threads.subject` and `emails.from_name`/`from_email`, not client-side-only filtering of a partial list.
- FR-3: Filter and search state must both be representable simultaneously in the URL (e.g., `?filter=unread&q=invoice`).
- FR-4: Clicking a thread row navigates to `/inbox/[threadId]`.

## Non-Goals

- No full-text body search in v1 (per project scope decision — subject/sender only).
- No pagination beyond a simple "load more"/infinite-scroll if the list grows large; a fixed reasonable page size (e.g., 50) with a "Load more" button is sufficient for v1.
- No drag-to-reorder, labels, or folders in v1 — a single flat inbox list.

## Design Considerations

- List rows use thin 1px dividers (`#2A2E3D`), not cards with shadows.
- Snippet text and timestamps render in the monospace typeface per the Dusk Terminal signature detail; sender/subject render in the humanist sans.
- Empty inbox state: centered, quiet message ("Nothing here yet") with no illustration, consistent with the calm aesthetic.

## Success Metrics

- Inbox list with 200+ threads renders and is searchable/filterable without perceptible lag (<200ms interaction response).

## Open Questions

- Should there be a "select multiple + bulk mark read/delete" affordance in v1, or one-at-a-time only? (Assumption: one-at-a-time only for v1; bulk actions are a fast-follow.)
