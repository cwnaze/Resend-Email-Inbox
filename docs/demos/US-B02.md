# Send me a code endpoint with rate limiting

*2026-07-27T13:03:05Z by Showboat 0.6.1*
<!-- showboat-id: afd6bf25-af83-4195-a23a-f58f7991098e -->

This story implements POST /api/auth/request-code: generates a CSPRNG 6-digit code, stores only its SHA-256 hash, inserts an auth_codes row (expires_at = now + 10 min), invalidates any previously active code, and sends the code via Resend to the constant AUTH_RECIPIENT_EMAIL. Requests are rate-limited to 3 per rolling 10-minute window; the 4th+ request in that window returns 429 without creating a row or sending an email.

```bash
npm run check 2>&1 | tail -5 | sed -E 's/^[0-9]+ //'
```

```output
> resend-email-inbox@0.0.1 check
> svelte-kit sync && svelte-check --tsconfig ./tsconfig.json

START "/Users/bloodintern1/Desktop/Resend-Email-Inbox"
COMPLETED 1194 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```

```bash
npm run lint 2>&1 | tail -10
```

```output

> resend-email-inbox@0.0.1 lint
> prettier --check . && eslint .

Checking formatting...
All matched files use Prettier code style!
```

```bash
npm run build 2>&1 | grep -E '^✓ built|^Error:' | sed -E 's/[0-9]+(\.[0-9]+)?(ms|s)/<duration>/'
```

```output
✓ built in <duration>
✓ built in <duration>
```

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/auth/verify-request-code.mts
```

```output
1. Code generation and hashing:
  PASS: generated code is exactly 6 digits
  PASS: 100 generated codes yield more than one distinct value
  PASS: hashing the same code twice yields the same hash
  PASS: hashing two different codes yields different hashes
  PASS: the stored hash is never equal to the raw code
2. Rate limiting (3 requests per rolling window):
  PASS: exactly 3 additional requests are counted after 3 creates
  PASS: a 4th request in the same window would be rejected (count >= 3)
3. Invalidation (only one active code at a time):
  PASS: the 2 earlier codes were superseded (expires_at pulled back) when later codes were requested
  PASS: exactly 1 code (the most recent) remains active
  PASS: superseding never sets used_at (that means "redeemed", not "superseded")

Cleaning up test rows...
  PASS: all test rows were cleaned up (window count back to baseline)

11 passed, 0 failed
```

Manual live verification (not re-executed by `showboat verify` since it requires a running dev server plus DB seed/cleanup around it), all against the live Turso DB with every test row deleted by id afterward:

- **Rate limit + `Retry-After`:** seeding 3 auth_codes rows (simulating 3 recent requests) and then POSTing to /api/auth/request-code returned `HTTP/1.1 429 Too Many Requests` with `retry-after: 600` and `{"error":"Too many code requests. Please try again later."}` — the 4th request in the rolling window is rejected before any DB write or Resend call.
- **Failed-send rollback:** POSTing under the limit created an auth_codes row and reached the real Resend API, which rejected the placeholder RESEND_API_KEY (no real Resend account exists in this dev environment). The endpoint returned `HTTP/1.1 502` with generic copy `{"error":"Could not send the code. Please try again."}` — no Resend detail leaked to the client — and the row was rolled back: a follow-up count of auth_codes rows in the 10-minute window returned 0, so the undeliverable code neither superseded the user's working code nor consumed a rate-limit slot.
- **Build no longer needs Resend secrets:** with RESEND_API_KEY and AUTH_RECIPIENT_EMAIL commented out of `.env`, `npm run build` still completes (`✔ done`) — the env reads are lazy, so CI and fresh clones don't need placeholder secrets.

Outstanding manual step (not blocking `passes: true`, same pattern as the R2/Vercel env vars from US-A02): this environment has no real Resend account, so `.env` only has a placeholder RESEND_API_KEY and the real AUTH_RECIPIENT_EMAIL. The project owner must provision a real Resend API key (and add both RESEND_API_KEY and AUTH_RECIPIENT_EMAIL to Vercel project settings) before this endpoint can actually deliver login-code emails in production.

