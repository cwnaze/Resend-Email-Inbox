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
COMPLETED 1190 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
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
  PASS: two independently generated codes were produced
  PASS: hashing the same code twice yields the same hash
  PASS: hashing two different codes yields different hashes
  PASS: the stored hash is never equal to the raw code
2. Rate limiting (3 requests per rolling window):
  PASS: no prior auth_codes rows exist in the window before this run
  PASS: exactly 3 requests are counted after 3 creates
  PASS: a 4th request in the same window would be rejected (count >= 3)
3. Invalidation (only one active code at a time):
  PASS: the 2 earlier codes were invalidated (used_at set) when later codes were requested
  PASS: exactly 1 code (the most recent) remains active

Cleaning up test rows...
  PASS: all test rows were cleaned up (window count back to 0)

11 passed, 0 failed
```

Manual live verification (not re-executed by  since it requires a running dev server plus DB seed/cleanup around it): with the dev server running, seeding 3 auth_codes rows (simulating 3 recent requests) and then POSTing to /api/auth/request-code returned `429 {"error":"Too many code requests. Please try again later."}` — confirming the 4th request in the rolling window is rejected before any DB write or Resend call. Separately, POSTing with fewer than 3 recent rows present created a new auth_codes row and attempted the Resend send; against the real Resend API with a placeholder RESEND_API_KEY (no real Resend account exists in this dev environment), the call correctly reached Resend and failed with a clean `401 API key is invalid`, confirming the integration is wired correctly end-to-end up to the point where a real API key is required. Both cases' test rows were deleted by id afterward to leave the live Turso DB clean.

Manual live verification (not re-executed by `showboat verify` since it requires a running dev server plus DB seed/cleanup around it): with the dev server running, seeding 3 auth_codes rows (simulating 3 recent requests) and then POSTing to /api/auth/request-code returned `429 {"error":"Too many code requests. Please try again later."}` — confirming the 4th request in the rolling window is rejected before any DB write or Resend call. Separately, POSTing with fewer than 3 recent rows present created a new auth_codes row and attempted the Resend send; against the real Resend API with a placeholder RESEND_API_KEY (no real Resend account exists in this dev environment), the call correctly reached Resend and failed with a clean `401 API key is invalid`, confirming the integration is wired correctly end-to-end up to the point where a real API key is required. Both cases' test rows were deleted by id afterward to leave the live Turso DB clean.

Outstanding manual step (not blocking `passes: true`, same pattern as the R2/Vercel env vars from US-A02): this environment has no real Resend account, so `.env` only has a placeholder RESEND_API_KEY and the real AUTH_RECIPIENT_EMAIL. The project owner must provision a real Resend API key (and add both RESEND_API_KEY and AUTH_RECIPIENT_EMAIL to Vercel project settings) before this endpoint can actually deliver login-code emails in production.

