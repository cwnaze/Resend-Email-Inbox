# PRD: Feature — Contacts / Senders

## Introduction

A view of everyone the app owner has exchanged email with, auto-populated from message history, with manual editing support.

## Goals

- Give a browsable list of everyone the app owner has corresponded with
- Allow correcting/editing auto-derived contact names
- Feed the To/Cc autocomplete in Compose

## User Stories

### US-I01: Contacts list view
**Description:** As the app owner, I want to see everyone I've emailed or received email from, so I have a quick reference of my correspondents.

**Acceptance Criteria:**
- [ ] `/contacts` lists all `contacts` rows sorted alphabetically by display name (falling back to email if no name)
- [ ] Each row shows name, email, and (if available) a count or "last contacted" timestamp derived from `emails`
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-I02: Edit a contact
**Description:** As the app owner, I want to fix a contact's display name, so my contacts list stays clean even when senders use inconsistent "From" names.

**Acceptance Criteria:**
- [ ] Each contact row has an edit action opening an inline or modal form with a `name` field
- [ ] Saving updates the `contacts` row and sets `auto_created = false` so future inbound emails from that address don't overwrite the name
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-I03: Manually add a contact
**Description:** As the app owner, I want to add a contact by hand even before they've emailed me, so I can address a new email to them from Compose.

**Acceptance Criteria:**
- [ ] `/contacts` has an "Add contact" action with name + email fields
- [ ] Duplicate email (case-insensitive) is rejected with an inline error pointing to the existing contact
- [ ] New manual contacts are created with `auto_created = false`
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-I04: Contact autocomplete in Compose
**Description:** As the app owner, I want typing in the To/Cc field of Compose to suggest existing contacts, so I don't have to remember or retype addresses.

**Acceptance Criteria:**
- [ ] Typing in Compose's To/Cc field queries `contacts` by name/email substring match and shows matching suggestions
- [ ] Selecting a suggestion fills the field with that contact's email
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: Contacts are automatically upserted by email address (case-insensitive) whenever a new sender/recipient appears in inbound or outbound mail (per Data Model and Inbound Processing PRDs).
- FR-2: Manual edits set `auto_created = false`, permanently protecting the name from being overwritten by future auto-derivation for that email.
- FR-3: Contact search/autocomplete must be usable from the Compose feature without a full page navigation (inline query).

## Non-Goals

- No contact groups/tags in v1.
- No merge-duplicate-contacts tooling in v1 (case-insensitive email uniqueness prevents most duplicates by construction).
- No import/export or sync with external address books in v1.

## Design Considerations

- Contacts list follows the same flat, divider-based row style as the Inbox List, keeping the app's visual language consistent.
- Email addresses render in monospace per the signature style detail.

## Success Metrics

- Every unique sender across 50 test inbound emails produces exactly one contact row (no duplicates from casing differences).

## Open Questions

- Should contacts be deletable, or only editable? (Assumption: deletable — removing a contact does not affect historical `emails` rows, which store from/to as plain text/JSON independent of the `contacts` table.)
