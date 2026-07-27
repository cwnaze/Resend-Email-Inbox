# US-E04: Thread assignment

*2026-07-27T19:06:30Z by Showboat 0.6.1*
<!-- showboat-id: 21fc7706-c346-43bb-9f98-0ff1214d19ff -->

Replies must land in the conversation they belong to instead of each becoming its
own thread.

Strategy, per FR-4 of `tasks/prd-feature-inbound-processing.md`:

1. **Header matching (primary).** `In-Reply-To`, then the `References` chain
   nearest-ancestor-first, is looked up against `emails.message_id`. A hit
   reuses that email's `thread_id`.
2. **Normalized subject within 30 days (secondary).** Only when no header
   matches. `threads.subject` stores the *normalized* form (`Re:`/`Fwd:`
   prefixes stripped, whitespace collapsed, lowercased) so this is a plain
   equality match, not a scan.
3. **New thread** otherwise.

Then `threads.last_message_at` / `threads.is_read` are updated per the Data
Model PRD: `is_read` is forced back to false (it means "every message read"),
and `last_message_at` only ever moves forward so a late redelivery of an old
message can't drag a thread down the inbox sort order.

New code: `src/lib/server/inbound/threading.ts` (pure subject normalization),
three helpers in `src/lib/server/db/emails.ts`
(`findThreadIdByMessageIds`, `findThreadBySubject`, `touchThreadForNewMessage`),
and the `assignThread` step inside `src/lib/server/inbound/store.ts`.

```bash
cat src/lib/server/inbound/threading.ts
```

```output
// Subject normalization for thread grouping (US-E04).
//
// Pure by design — no env, no db, no network — same rule as `parse.ts`, so the
// fixture-driven `verify-inbound-parse.mts` script can exercise it directly.
//
// `threads.subject` stores the *normalized* subject (Data Model PRD: "normalized
// subject (e.g., 'Re:' stripped for grouping)"), so the subject fallback in
// FR-4 can compare stored-normalized against incoming-normalized without a
// second normalization pass over the table at query time. The per-email
// `emails.subject` keeps the sender's original wording.

/**
 * Reply/forward prefixes, in the localized forms worth handling. Matched
 * case-insensitively, with an optional bracketed counter (`Re[2]:`, `Re(2):`)
 * that some clients add.
 */
const REPLY_PREFIX = /^\s*(?:re|aw|sv|vs|fwd?|tr|wg|rv|enc)\s*(?:[[(]\d+[\])])?\s*:\s*/i;

/**
 * Strips reply/forward prefixes and collapses whitespace.
 *
 * The prefixes are stripped in a loop, not once: `Re: Fwd: Re: foo` is a single
 * conversation and every hop adds another one. Case and whitespace are
 * normalized too, because `threads_subject`-based grouping is a plain string
 * comparison in SQLite and `RE:  Foo ` must not start a second thread from
 * `Re: Foo`.
 *
 * An empty or whitespace-only subject normalizes to `''`. Callers must treat
 * that as *unthreadable* rather than as a group key — every subject-less email
 * in the mailbox would otherwise collapse into one thread.
 */
export function normalizeSubject(subject: string): string {
	let value = subject.replace(/\s+/g, ' ').trim();

	// Bound the loop: a pathological subject of nothing but prefixes shouldn't
	// spin, and no real conversation is 20 hops of `Re:` deep.
	for (let i = 0; i < 20; i++) {
		const stripped = value.replace(REPLY_PREFIX, '');
		if (stripped === value) break;
		value = stripped.trim();
	}

	return value.toLowerCase();
}

/** Window for the FR-4 subject fallback: same normalized subject within 30 days. */
export const SUBJECT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
```

The thread choice itself, in `store.ts`:

```bash
sed -n '33,75p' src/lib/server/inbound/store.ts
```

```output
/**
 * Picks the thread a parsed email belongs to (US-E04, FR-4).
 *
 * Order is header matching first, subject fallback second, new thread last.
 * `In-Reply-To` and `References` are checked against `emails.message_id`;
 * headers are authoritative when present, and only their absence (or an
 * unknown parent) falls back to the fuzzy 30-day same-subject heuristic.
 *
 * Returns the created thread's id plus `createdThreadId` so the caller can undo
 * it if the email insert turns out to be a duplicate — a thread with nothing
 * pointing at it is litter in the inbox list.
 */
async function assignThread(
	db: Database,
	parsed: ParsedInboundEmail,
	normalizedSubject: string,
	now: Date
): Promise<{
	threadId: string;
	match: 'reply' | 'subject' | 'new';
	createdThreadId: string | null;
}> {
	// `References` is oldest-first; reverse it so the nearest ancestor wins after
	// the direct parent.
	const ancestors = [parsed.inReplyTo, ...[...parsed.references].reverse()].filter(
		(id): id is string => typeof id === 'string' && id !== ''
	);

	const replyThreadId = await findThreadIdByMessageIds(db, ancestors);
	if (replyThreadId) return { threadId: replyThreadId, match: 'reply', createdThreadId: null };

	const since = new Date(now.getTime() - SUBJECT_THREAD_WINDOW_MS);
	const subjectThread = await findThreadBySubject(db, normalizedSubject, since);
	if (subjectThread) {
		return { threadId: subjectThread.id, match: 'subject', createdThreadId: null };
	}

	const thread = await createThread(db, {
		subject: normalizedSubject,
		lastMessageAt: parsed.receivedAt
	});
	return { threadId: thread.id, match: 'new', createdThreadId: thread.id };
}
```

Verification: `verify-inbound-parse.mts` gained the US-E04 assertions — pure `normalizeSubject` cases, plus live-DB threading against the real Turso database (every inserted row is removed in the script's `finally`). Trimmed here to the new sections and the totals; the full run covers US-E02/E03 too.

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/inbound/verify-inbound-parse.mts | sed -n '/normalizeSubject/,/^$/p;/thread assignment/,$p'
```

```output
normalizeSubject (US-E04)
  ok   plain subject lowercased
  ok   Re: stripped
  ok   stacked prefixes stripped
  ok   counted prefix stripped
  ok   whitespace collapsed
  ok   empty subject stays empty
  ok   a colon inside the subject survives

storeInboundEmail — thread assignment
  ok   a fresh conversation starts a new thread
  ok   the thread stores the normalized subject
  ok   a new unread message leaves the thread unread
  ok   In-Reply-To matches an existing message_id
  ok   the reply joins the parent thread
  ok   a new message makes a read thread unread again
  ok   last_message_at moved to the reply
  ok   an unknown parent falls through to References
  ok   References threading picks the same thread
  ok   headerless same-subject mail falls back to subject
  ok   subject fallback picks the same thread
  ok   a late older message does not move last_message_at back
  ok   the same subject 60+ days later is a new thread
  ok   and it is genuinely a different thread
  ok   an unrelated subject starts its own thread
  ok   unrelated mail is not merged
cleanup: 8 email row(s) and 8 thread row(s) removed

cleanup: 2 row(s) removed, 0 remaining

95/95 checks passed
```

## End to end: a real inbound email lands on a thread

The endpoint suite (`verify-inbound-webhook.mts`, now 14 checks) posts a genuinely-signed
`email.received` envelope naming a **real** received email in this project's Resend account,
then reads the row back through its thread — the new US-E04 check asserts the stored email
joins a `threads` row carrying the *normalized* subject, left unread, with `last_message_at`
at least the message's own timestamp.

The script now also clears its own leftovers from a previous run before ingesting. That's not
housekeeping: without it the first ingest is answered as a duplicate and the assertions
describe whatever an *older* run stored — which is exactly how a stale pre-US-E04 thread row
(raw subject, written before normalization existed) made this check fail on the first attempt.
Emails are deleted before their threads: `emails.thread_id` is a real FK and this connection
enforces it.

Output is filtered to the assertion lines; the run also prints a real email id and a row
count, neither stable across runs.

```bash
set -e
npm run dev >/tmp/us-e04-dev.log 2>&1 &
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
PASS  email is attached to a thread with the normalized subject, unread, sorted by its own timestamp
PASS  non-received event type is ignored -> 200 (expected 200)
PASS  permanently-unfetchable email_id is ignored, not retried -> 200 (expected 200)
All webhook checks passed
```

## Quality checks

```bash
npm run check 2>&1 | sed -E 's/^[0-9]+ /TS /'
```

```output

> resend-email-inbox@0.0.1 check
> svelte-kit sync && svelte-check --tsconfig ./tsconfig.json

TS START "/Users/bloodintern1/Desktop/Resend-Email-Inbox"
TS COMPLETED 1487 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```

```bash
npm run lint 2>&1 | tail -n 3
```

```output

Checking formatting...
All matched files use Prettier code style!
```
