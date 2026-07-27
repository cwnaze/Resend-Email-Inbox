# US-E03: Sanitize HTML body and store email

*2026-07-27T18:54:37Z by Showboat 0.6.1*
<!-- showboat-id: b07f5ad2-112d-44c1-8e51-55043ea2e2d6 -->

**Story:** As the app owner, I want inbound HTML sanitized before it's stored, so no malicious
markup ever reaches my browser.

Three things land here, all on the *write* path of the inbound webhook:

- `src/lib/server/inbound/sanitize.ts` — `sanitizeEmailHtml`, the single place inbound HTML is
  cleaned. Pure (no env/db/network) like `parse.ts`, so it is fixture-testable. Sanitizing on
  write rather than on render means nothing unsafe is ever *in* `emails.body_html`, so no future
  renderer can forget to re-sanitize.
- `src/lib/server/db/emails.ts` — query helpers for `emails`/`threads` (db-handle-first, same
  shape as `contacts.ts`). `insertInboundEmail` is idempotent on `message_id` via
  `onConflictDoNothing()` + re-read, the same race-safe pattern the contact upsert uses.
- `src/lib/server/inbound/store.ts` — `storeInboundEmail`: duplicate check, thread, sanitize,
  insert. The endpoint just calls it.

`body_text` is stored verbatim — it is never rendered as markup, so mangling its whitespace
would only lose information.

## Sanitizer and storage, exercised directly

`verify-inbound-parse.mts` (extended, now 72 checks) covers the sanitizer against a fixture body
that bundles every disallowed construct — `<script>`, an `onerror` handler, a `javascript:` href,
`<iframe>`, `<link>`, `<style>`, `srcset`/`style`/`data-*` attributes and a `<form>` — and then
drives `storeInboundEmail` against the live Turso DB, including a redelivery. Every row it writes
is removed in the `finally` block.

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/inbound/verify-inbound-parse.mts 2>&1 | sed -n "/^sanitizeEmailHtml/,\$p"
```

```output
sanitizeEmailHtml
  ok   keeps benign markup
  ok   keeps a safe link
  ok   strips <script>
  ok   strips event handlers
  ok   strips javascript: URLs
  ok   strips <iframe>
  ok   strips <link>
  ok   strips <style> and its contents
  ok   strips srcset / style / data-* attributes
  ok   strips <form>/<input>
  ok   leaves no reference to the evil host
  ok   null in, null out
  ok   undefined in, null out
  ok   blank in, null out
  ok   all-malicious body collapses to null

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

storeInboundEmail — live DB
  ok   a new message_id is stored
  ok   direction is inbound
  ok   body_html is sanitized on the way in
  ok   body_text is stored as-is
  ok   from_email
  ok   to_emails round-trips as JSON
  ok   received_at from the Date: header
  ok   a thread was created for it
  ok   exactly one thread row
  ok   redelivery is detected as a duplicate
  ok   duplicate returns the original row
  ok   still exactly one email row
  ok   the duplicate left no orphan thread
cleanup: 1 email row(s) and 1 thread row(s) removed

cleanup: 2 row(s) removed, 0 remaining

72/72 checks passed
```

## End to end: a real inbound email is stored

The endpoint suite (`verify-inbound-webhook.mts`, now 14 checks) posts a genuinely-signed
`email.received` envelope naming a **real** received email in this project's Resend account,
then reads the `emails` table back: exactly one row for that `message_id` after a redelivery,
and its stored `body_html` free of script/handler/iframe markup. Output is filtered to the
assertion lines — the run also prints a real email id and a pre-ingestion row count, neither
stable across runs.

```bash
set -e
npm run dev >/tmp/us-e03-dev.log 2>&1 &
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
PASS  email stored exactly once after redelivery -> 1 row(s) (expected 1)
PASS  stored body_html contains no script/handler/iframe markup
PASS  non-received event type is ignored -> 200 (expected 200)
PASS  permanently-unfetchable email_id is ignored, not retried -> 200 (expected 200)
All webhook checks passed
```

The stored row itself, read straight out of Turso. Only structural facts are printed — the row
is a real person's mail, so no address or body text goes into a committed demo doc.

```bash
cat > src/lib/server/db/_demo-row.mts <<'EOF'
import { createClient } from "@libsql/client";
const c = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
const { rows } = await c.execute(
  "select direction, is_read, is_deleted, body_html, body_text, thread_id from emails order by created_at desc limit 1"
);
const r = rows[0] as Record<string, unknown>;
const html = String(r.body_html ?? "");
console.log("direction         =", r.direction);
console.log("is_read/is_deleted=", r.is_read, "/", r.is_deleted);
console.log("has thread_id     =", typeof r.thread_id === "string" && r.thread_id.length > 0);
console.log("body_html tags    =", [...new Set([...html.matchAll(/<([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase()))].sort().join(","));
console.log("unsafe markup     =", /<script|\son\w+\s*=|<iframe|<style|<link/i.test(html));
console.log("body_text stored  =", typeof r.body_text === "string" && r.body_text.length > 0);
const { rows: t } = await c.execute({ sql: "select count(*) as n from threads where id = ?", args: [String(r.thread_id)] });
console.log("thread row exists =", Number(t[0].n) === 1);
c.close();
EOF
node --env-file=.env node_modules/.bin/tsx src/lib/server/db/_demo-row.mts
rm src/lib/server/db/_demo-row.mts
```

```output
direction         = inbound
is_read/is_deleted= 0 / 0
has thread_id     = true
body_html tags    = a,br,div,img,table,tbody,td,tr
unsafe markup     = false
body_text stored  = true
thread row exists = true
```

That is a real marketing-styled HTML email: the surviving tag set has no `style`, `script`,
`link` or `iframe` in it, and `body_text` came through untouched.

## Quality checks

```bash
npm run check 2>&1 | grep -E "^[0-9]+ [A-Z]+ .*ERRORS" | sed -E "s/^[0-9]+ /(timing stripped) /"
```

```output
(timing stripped) COMPLETED 1486 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
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
