# Contacts — `/contacts`

Feature PRD: `tasks/prd-feature-contacts.md`. The `contacts` table itself is written by
the inbound webhook and the send path (`upsertAutoContact`, see `docs/notes/inbound.md`
and `docs/notes/compose.md`); this note covers `/contacts` itself — the read side added
by US-I01 and the rename added by US-I02.

## `listContacts` (`src/lib/server/db/contacts.ts`)

One query for the whole page: a **LEFT JOIN** from `contacts` onto `emails`, grouped by
contact, with the correspondence rule in the join condition (`CORRESPONDS_WITH_CONTACT`).

- **LEFT, not INNER** — deliberately the opposite choice from `listInboxThreads`, whose
  inner join doubles as "a thread with no visible message is not a row". A contact with
  no surviving mail is still a contact (a manually added one, US-I03, has none by
  definition), so it must render at `0 messages` rather than vanish. `count(emails.id)`
  rather than `count(*)` is what makes the no-match row count 0 instead of 1.
- **The link is by address, not by foreign key.** `emails` stores from/to/cc as plain
  text and JSON, independent of `contacts` — that's what lets a contact be deleted
  without rewriting history (the PRD's open question), and it's why the join has to
  `json_each` over `to_emails`/`cc_emails`. `cc_emails` is nullable and `json_each`
  errors on a NULL argument, hence the `coalesce(…, '[]')`.
- **`lower()` on both sides.** Addresses in `emails` were never case-normalized (only
  `contacts.email` is, on write — see `normalizeEmail`), so a case-sensitive comparison
  silently under-counts.
- **`bcc_emails` is not searched.** A Bcc recipient isn't part of the visible
  correspondence on a thread, and a real correspondent shows up in `to`/`cc` anyway.
  If that ever changes, change it here and in `verify-contacts-list.mts` together.
- **Sorted by `coalesce(name, email) collate nocase`**, matching
  `listContactsForSuggestions` so the list and the compose autocomplete agree on order.
- `messageCount`/`lastContactedAt` come back through `sql<…>` templates, so Drizzle's
  `timestamp_ms` mode does _not_ apply — the helper wraps the raw millisecond number in
  a `Date` itself.

`src/lib/server/db/verify-contacts-list.mts` is the smoke test for all of the above
against the live DB (case folding, Cc, Bcc, soft-delete, no-mail contacts) **and** for
`updateContactName` below. **Extend it** rather than adding another script when US-I03
adds a write helper here — the SQL is the part no typecheck covers.

## `updateContactName` (US-I02)

One statement setting `name` _and_ `auto_created = false`, deliberately not two things:

- **Clearing the flag is the edit's durability, not a side feature.** The flag is the
  only thing between the owner's chosen name and the next inbound delivery from that
  address, which `upsertAutoContact` would otherwise use to overwrite it. A rename that
  didn't clear it would look like it worked and silently revert on the next email. The
  verify script asserts the _pair_ (rename → auto-upsert → name survives), because that
  round trip is the only thing that actually demonstrates FR-2.
- **A blank name stores `null`, not `''`.** `null` is what the sort and `displayName`
  already read as "fall back to the address"; `''` would sort ahead of every real name.
  Clearing still clears the flag — choosing to show the bare address is an owner decision
  too, and must survive the next delivery.
- **Returns `undefined` for an unknown id** rather than throwing; the route turns that
  into a 404.
- `MAX_CONTACT_NAME_LENGTH` (200) is exported from the same module because the form's
  `maxlength` and the action's own check have to be one number. The action re-checks —
  `maxlength` is a browser courtesy, not the rule.

## Editing a row

`?edit=<id>` — the open row is **server state in the URL**, not component state. That is
what makes the form render with JavaScript off, survive a refresh, and still be open
after a `fail()`. Consequences worth keeping:

- The Edit affordance is a plain `<a>`, and Cancel is a link back to `/contacts`. Both
  build their href by decorating `resolve('/(app)/contacts')` and casting to
  `ResolvedPathname` — `resolve()` has no query form (see the root `CLAUDE.md` rule).
- The form posts to **`?/rename&edit=<id>`**. A form action's query replaces the page's,
  so without the `edit` there, a `fail()` re-render would close the very form the owner
  is being asked to correct.
- The load returns the raw `name` alongside `displayName`, because the input has to be
  seeded with the _stored_ value. Seeding it with `displayName` would turn "this contact
  has no name" into "this contact is named after its own address" on the first save.
- The `fail()` payload carries the contact `id`, and `+page.svelte` only shows the message
  on the matching row, so an error can't annotate a row it wasn't about.
- The action **calls `validateSession` itself** — an action runs before the group layout's
  load (`docs/notes/auth.md`) — and ends in a `redirect(303, …)` to the bare `/contacts`,
  which both closes the form and keeps `?/rename` out of the address bar (this form is
  deliberately not `use:enhance`d).

## The route

`src/routes/(app)/contacts/` — `+page.server.ts` (load + the `rename` action),
`+page.svelte`, `ContactRow.svelte`. Same flat divider-row style and `max-w-3xl` cap as
the inbox list, per the PRD's design note.

- The load is **read-only**, so the `(app)` layout's session check covers it. Every action
  here does not get that: a form action runs _before_ the layout load, so each one calls
  `validateSession` itself (`docs/notes/auth.md`) — `rename` is the worked example, and
  US-I03's add action needs the same.
- `displayName` (name, falling back to the address) is resolved **in the load**, because
  that's also the expression the query sorted by; deriving it again in the component is
  how the heading and the ordering drift apart. `ContactRow` renders the address on its
  own line only when it isn't already the heading.
- `lastContactedAt` crosses the wire as a `Date` (SvelteKit serializes it) so the row can
  emit both a relative label via `relativeTime` and a machine-readable `<time datetime>`,
  same as `ThreadRow`.
- The **Contacts** link lives in `(app)/+layout.svelte` beside Compose: both are
  whole-app destinations rather than one route's state, unlike the search box and the
  thread list, which were pushed down into the inbox subtree. Compose keeps the only
  accent styling in that bar; Contacts is plain-toned. Compose's `ml-auto` moved onto the
  Contacts link when it was added — exactly one item in that row carries it.

## Demo fixture

`seed-f03-demo.mts` Cc's `casey@<stamp>.example` on one seeded message and leaves the
other two demo contacts with no mail, so a browser demo shows both sides of the LEFT JOIN
without seeding anything by hand.
