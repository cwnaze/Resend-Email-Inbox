# US-E02: Parse inbound payload and upsert contact

*2026-07-27T18:34:10Z by Showboat 0.6.1*
<!-- showboat-id: f87bc83e-5ff2-4b5e-b86f-e09253be086d -->

## What this story does

`POST /api/webhooks/resend-inbound` no longer stops at the signature gate. A verified
`email.received` event is now parsed into the fields the data model wants, and the sender is
upserted into `contacts`.

## The load-bearing discovery: the webhook is metadata-only

US-E01 left a warning that the payload shape was unverified ("a placeholder, not observed
truth"). It was checked against this project's real Resend account before any parser was
written, and the assumption in the PRD was wrong in a way that changes the design of US-E02
through US-E05:

> Webhooks do not include the email body, headers, or attachments, only their metadata.
> You must call the Received emails API or the Attachments API to retrieve them.
> — https://resend.com/docs/webhooks/emails/received

So `In-Reply-To`, the `From:` display name, the `Date:` header and `html`/`text` are simply
absent from the webhook. Ingestion is necessarily two calls: verify the webhook, then fetch
the content by `email_id` (`resend.emails.receiving.get`, added as `fetchReceivedEmail`).

Two quirks in the *real* fetched record, both now covered by fixtures:

- Resend hands some header values back **JSON-encoded**: an observed delivery had
  `date: "\"2026-07-25T15:15:31.000Z\""` and `received: "[\"from …\"]"`.
- The bare sender address comes from the record's own `from` field; the display name only
  exists inside `headers.from` (e.g. `"Google" <noreply@google.com>`). The address is
  deliberately *not* read from that header — a crafted `From:` must not be able to disagree
  with the envelope Resend validated.

## Files

- `src/lib/server/inbound/parse.ts` — `parseInboundWebhookEvent` (envelope → `email_id`, discriminated result) and `parseReceivedEmail` (fetched record → `ParsedInboundEmail`). Both pure: no env, no db, no network.
- `src/lib/server/db/contacts.ts` — `normalizeEmail`, `getContactByEmail`, `upsertContactFromInbound`. Takes the db handle as its first argument, same as the auth helpers.
- `src/lib/server/email/resend.ts` — `fetchReceivedEmail` added alongside `sendAuthCodeEmail` (one Resend client, per the project convention).
- `src/routes/api/webhooks/resend-inbound/+server.ts` — verify → parse → fetch → parse → upsert.
- `src/lib/server/inbound/verify-inbound-parse.mts` (new) and `src/lib/server/webhooks/verify-inbound-webhook.mts` (extended) — verification scripts.

## Parsing + contact upsert: 44 checks

Parsing runs against fixtures (one of them a redacted **real** delivery, header quirks verbatim).
The upsert runs against the live Turso DB — there is no separate test database — and deletes
every row it inserts in a `finally` block.

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/inbound/verify-inbound-parse.mts
```

```output

parseInboundWebhookEvent
  ok   accepts a real email.received envelope
  ok   extracts email_id
  ok   rejects a non-received event type
  ok   rejects a non-object payload
  ok   rejects a null payload
  ok   rejects a missing data object
  ok   rejects a missing email_id
  ok   rejects an empty email_id

parseReceivedEmail — real delivery
  ok   message_id
  ok   from address is lowercased from Resend`s own field
  ok   display name unquoted from the From: header
  ok   to
  ok   cc defaults to empty
  ok   subject
  ok   bodyHtml passed through unsanitized (US-E03 sanitizes)
  ok   bodyText
  ok   no In-Reply-To
  ok   no References
  ok   receivedAt comes from the JSON-quoted Date: header
  ok   attachments

parseReceivedEmail — reply with no display name
  ok   bare From: yields a null display name
  ok   In-Reply-To
  ok   References split on whitespace
  ok   cc trimmed, empties dropped

parseReceivedEmail — JSON array-encoded headers
  ok   array-encoded References decoded, not split as JSON text
  ok   array-encoded In-Reply-To takes the first value

parseReceivedEmail — reply, remaining fields
  ok   null html stays null
  ok   unparseable Date: falls back to created_at

upsertContactFromInbound — live DB
  ok   new sender is created
  ok   email is stored lowercased
  ok   name comes from the payload
  ok   auto_created is true
  ok   case-different address matches the same row
  ok   same contact id
  ok   exactly one row exists for the address
  ok   auto-created name is refreshed
  ok   new name persisted
  ok   null payload name does not update
  ok   existing name preserved
  ok   manually-edited contact is not renamed
  ok   hand-written name survives
  ok   auto_created stays false
  ok   whitespace-only name does not update
  ok   getContactByEmail is case-insensitive

cleanup: 2 row(s) removed, 0 remaining

44/44 checks passed
```

## End to end against a real inbound email

This is the check US-E01 could not make: the five signature cases *plus* a genuinely-signed
`email.received` envelope naming a **real** received email in this project's Resend account.
The endpoint fetches it, parses it and upserts the sender. Redelivery (Resend retries 5xx and
can redeliver anyway) must not duplicate the contact, and a verified payload of some other
event type must be ignored with a 200 rather than a 500 retry-loop.

The block starts its own dev server and reads the real `.env` — part 2 needs the Resend API
key and Turso, and skips itself with a printed note when they are absent. Output is filtered
to the assertion lines: the run also prints a real email id and the row count before ingestion,
neither of which is stable across runs.

```bash
set -e
npm run dev >/tmp/us-e02-dev.log 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null" EXIT
until curl -sf -o /dev/null http://localhost:5173/login; do sleep 1; done
node --env-file=.env node_modules/.bin/tsx src/lib/server/webhooks/verify-inbound-webhook.mts \
  | grep -E "^(PASS|FAIL|All |skipping)"
```

```output
PASS  valid signature -> 200 (expected 200)
PASS  tampered body, original signature -> 401 (expected 401)
PASS  signature from a different secret -> 401 (expected 401)
PASS  no svix headers -> 401 (expected 401)
PASS  missing svix-id header -> 401 (expected 401)
PASS  real email.received envelope is ingested -> 200 (expected 200)
PASS  sender upserted into contacts -> 1 row(s) (expected 1)
PASS  redelivery of the same email is accepted -> 200 (expected 200)
PASS  redelivery did not duplicate -> 1 row(s) (expected 1)
PASS  non-received event type is ignored -> 200 (expected 200)
PASS  permanently-unfetchable email_id is ignored, not retried -> 200 (expected 200)
All webhook checks passed
```

The resulting row, read straight out of Turso. The name `Google` was extracted from the real
delivery's `headers.from` (`"Google" <no-reply@accounts.google.com>`) — the webhook payload
alone could never have produced it. `auto_created = 1` marks it as ingestion-created, which is
what protects a later hand-edited name from being overwritten.

```bash
cat > /tmp/us-e02-row.mts <<'EOF'
import { createClient } from "@libsql/client";
const c = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
const { rows } = await c.execute("select email, name, auto_created from contacts order by email");
console.log(rows.map((r) => `${r.email} | ${r.name} | auto_created=${r.auto_created}`).join("\n"));
c.close();
EOF
cp /tmp/us-e02-row.mts src/lib/server/db/_demo-row.mts
node --env-file=.env node_modules/.bin/tsx src/lib/server/db/_demo-row.mts
rm src/lib/server/db/_demo-row.mts
```

```output
no-reply@accounts.google.com | Google | auto_created=1
```

## Quality checks

```bash
npm run check 2>&1 | grep -E "^[0-9]+ [A-Z]+ .*ERRORS" | sed -E "s/^[0-9]+ /(timing stripped) /"
```

```output
(timing stripped) COMPLETED 1480 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```

```bash
npm run lint 2>&1 | tail -2
```

```output
Checking formatting...
All matched files use Prettier code style!
```

```bash
npm run build >/dev/null 2>&1 && echo "build: success"
```

```output
build: success
```
