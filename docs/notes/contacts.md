# Contacts — `/contacts`

Feature PRD: `tasks/prd-feature-contacts.md`. The `contacts` table itself is written by
the inbound webhook and the send path (`upsertAutoContact`, see `docs/notes/inbound.md`
and `docs/notes/compose.md`); this note covers the read side added by US-I01.

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
  `timestamp_ms` mode does *not* apply — the helper wraps the raw millisecond number in
  a `Date` itself.

`src/lib/server/db/verify-contacts-list.mts` is the smoke test for all of the above
against the live DB (case folding, Cc, Bcc, soft-delete, no-mail contacts). **Extend it**
rather than adding another script when US-I02/US-I03 add write helpers here — the SQL is
the part no typecheck covers.

## The route

`src/routes/(app)/contacts/` — `+page.server.ts` (load only), `+page.svelte`,
`ContactRow.svelte`. Same flat divider-row style and `max-w-3xl` cap as the inbox list,
per the PRD's design note.

- The load is **read-only**, so the `(app)` layout's session check covers it. US-I02 and
  US-I03 add form actions here, and a form action runs *before* the layout load — each
  one has to call `validateSession` itself (`docs/notes/auth.md`).
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
