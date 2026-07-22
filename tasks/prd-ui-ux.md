# PRD: UI/UX — "Dusk Terminal" Design System

## Introduction

Defines the visual language, layout, responsive behavior, and interaction/state conventions shared across every screen: a calm, editorial-meets-terminal aesthetic with monospace metadata as its signature detail.

## Goals

- A cohesive, distinctive visual identity applied consistently across login, inbox list, thread view, compose, and contacts
- Clear, quiet empty/loading/error states everywhere data can be absent or fail
- Fully responsive from 375px mobile up through desktop

## Design System: Dusk Terminal

### Palette (dark-first, with light variant)

| Token | Dark | Light (proposed) | Usage |
|---|---|---|---|
| `background` | `#12141C` | `#F5F4F0` | app background |
| `surface` | `#1A1D28` | `#FFFFFF` | cards, panels, compose area |
| `border` | `#2A2E3D` | `#DEDCD3` | 1px dividers |
| `text-primary` | `#E6E8EF` | `#1A1D28` | body/headings |
| `text-muted` | `#8A90A3` | `#6B7280` | metadata, read items |
| `accent` | `#7FB4A6` | `#4E8A7A` | primary actions, unread dot, links |
| `accent-secondary` | `#C9A87C` | `#A97F45` | highlights, focus rings |
| `danger` | `#C97F7F` | `#B24A4A` | delete/destructive |

Theme is applied via a `data-theme` attribute or CSS custom properties toggled by a `prefers-color-scheme` default plus an explicit user toggle, implemented as Tailwind CSS variables.

### Typography

- UI + body: Inter (or similar humanist sans) for all prose, navigation, and buttons.
- Metadata — timestamps, sender/recipient addresses, thread IDs, the login code-entry field: JetBrains Mono (or IBM Plex Mono). This monospace-for-metadata pairing is the signature detail and must be applied consistently, not just on the login screen.
- Reading measure in thread view constrained to a comfortable column (~65–72ch), generous line-height (1.6+) for body text.

### Shape & Depth

- Border radius: 2–4px everywhere (buttons, inputs, cards) — no pill shapes.
- Depth comes from `surface` vs `background` color contrast and 1px `border` lines, never drop shadows.
- Unread indication: a small solid `accent`-colored dot + slightly brighter `text-primary` weight; read items recede to `text-muted`.

### Motion

- All transitions (hover, focus, panel open/close) run 120–160ms with a standard ease-out curve — no bounce/spring easing.

## Layout

- **Desktop (≥1024px):** two-pane layout — thread list in a left column (fixed width, e.g., 360px), thread/detail or compose in the remaining right pane.
- **Tablet (768–1023px):** single-pane, list and detail as separate views with a back affordance.
- **Mobile (<768px):** fully single-pane stack; bottom or top nav for Inbox/Compose/Contacts.
- App shell: minimal top bar (app mark, search, logout) — no heavy sidebar chrome.

## Interaction States (applies to every data-driven screen)

- **Loading:** skeleton rows/blocks in `surface` tone with subtle pulse, not spinners, for list views; a small inline spinner acceptable for button-triggered actions (e.g., Send).
- **Empty:** centered, quiet single-line message + optional one-line sub-copy, no illustrations (e.g., inbox: "Nothing here yet", search: "No matching threads", contacts: "No contacts yet").
- **Error:** inline, non-modal message near the point of failure (e.g., under the Send button, under the login code field) in the `danger` color, with a retry action where applicable.

## User Stories

### US-J01: Design tokens and Tailwind theme configuration
**Description:** As a developer, I need the Dusk Terminal palette, type scale, radii, and motion tokens available as reusable Tailwind config, so every screen stays visually consistent without redefining values.

**Acceptance Criteria:**
- [ ] Tailwind config (or CSS custom properties) defines all palette tokens above for both dark and light themes
- [ ] Font families for humanist sans and monospace are loaded and available as Tailwind font utilities
- [ ] Border radius scale limited to 2–4px options is available as a Tailwind utility/preset
- [ ] A theme toggle (or `prefers-color-scheme` default) switches all tokens correctly
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-J02: App shell layout (desktop two-pane, responsive collapse)
**Description:** As the app owner, I want a consistent shell around every screen that adapts from desktop to mobile, so the app feels coherent and usable on any device.

**Acceptance Criteria:**
- [ ] Desktop (≥1024px) renders the two-pane list/detail layout described above
- [ ] Viewport widths down to 375px show no horizontal scrolling and a usable single-pane stack
- [ ] Top bar includes app mark, search entry point, and logout action
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-J03: Shared empty/loading/error state components
**Description:** As a developer, I want reusable empty/loading/error components, so every feature PRD's states look and behave consistently.

**Acceptance Criteria:**
- [ ] A shared `EmptyState` component accepts a message + optional sub-copy
- [ ] A shared `Skeleton` component renders pulsing placeholder rows for list-shaped content
- [ ] A shared inline `ErrorMessage` component renders in the `danger` color with optional retry callback
- [ ] Used by Inbox List, Thread View, Compose, and Contacts per their respective PRDs
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: Every screen must use the shared design tokens (no one-off hex colors or ad-hoc radii in feature code).
- FR-2: Metadata fields (timestamps, email addresses, thread/message identifiers, code-entry input) must render in the monospace typeface everywhere they appear.
- FR-3: The app must remain fully usable with no horizontal scroll at a 375px viewport width.
- FR-4: Every list/detail view that can be empty, loading, or errored must use the shared state components rather than a bespoke implementation.

## Non-Goals

- No user-configurable theme beyond dark/light (no custom accent color picker in v1).
- No animation library — CSS transitions only, per the "quick and understated, no bounce" style principle.

## Success Metrics

- Visual QA pass across login, inbox list, thread view, compose, and contacts confirms consistent token usage (spot-checked, no automated visual regression tooling required for v1).
- App is fully operable (no horizontal scroll, all actions reachable) at 375px width.

## Open Questions

- Should the light theme's exact hex values be treated as final, or are they a placeholder pending visual review once the dark theme is built? (Assumption: placeholder — dark theme ships first and is the reference; light theme values are refined in a follow-up pass once the dark theme is validated visually.)

---

## Proposed Build Order (all PRDs)

1. **Architecture setup** — Turso + Drizzle wiring, R2 wiring, protected-route scaffold (`prd-architecture.md`)
2. **Data model** — full schema migration (`prd-data-model.md`)
3. **Design tokens & app shell** — Tailwind theme, shared state components (`prd-ui-ux.md` US-J01–J03), so subsequent features build on real styling from the start
4. **Auth** — code request/verify, session, login UI, route protection (`prd-auth.md`)
5. **Inbound processing** — webhook verification, parsing, sanitization, threading, attachments (`prd-feature-inbound-processing.md`)
6. **Inbox list** — thread list, read/unread, filter, search (`prd-feature-inbox-list.md`)
7. **Thread view** — full-thread rendering, sanitized HTML, attachments, soft delete (`prd-feature-thread-view.md`)
8. **Compose / reply / forward** — outbound send, threading headers, attachments (`prd-feature-compose.md`)
9. **Contacts** — list, edit, manual add, autocomplete (`prd-feature-contacts.md`)

This order ensures each layer has real data and UI to build against before the next depends on it: schema before backend logic, backend logic before UI, inbound-read path before outbound-send path (so there's something to reply to when Compose is built).
