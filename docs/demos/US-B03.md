# Verify-code endpoint and session creation

*2026-07-27T13:09:38Z by Showboat 0.6.1*
<!-- showboat-id: 20e7cf01-1798-41b5-9982-1e933b82e47a -->

US-B03: POST /api/auth/verify-code accepts a 6-digit code, hashes it, and compares against the most recently requested auth_codes row (via a new getLatestAuthCode helper, distinct from US-B01's getActiveAuthCode) so the endpoint can tell apart 'no code', 'already used', and 'expired' cases and give the right error without incrementing attempt_count against a dead code. On match: marks the code used, generates an opaque 32-byte session token, stores only its SHA-256 hash in sessions (createSession from US-B01), and sets it as an httpOnly/Secure/SameSite=Lax cookie. On mismatch: increments attempt_count; the 5th failed attempt invalidates the code (marks it used) so a new one must be requested.

```bash
npm run check 2>&1 | tail -5 | sed -E 's/^[0-9]+ //'
```

```output
> resend-email-inbox@0.0.1 check
> svelte-kit sync && svelte-check --tsconfig ./tsconfig.json

START "/Users/bloodintern1/Desktop/Resend-Email-Inbox"
COMPLETED 1192 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```

```bash
npm run lint 2>&1 | tail -6
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

Verified end-to-end against the live Turso database via a standalone script (same pattern as prior stories' verify-*.mts scripts), then manually against a running dev server via curl to confirm cookie attributes.

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/auth/verify-verify-code.mts 2>&1 | tail -25
```

```output
  PASS: getLatestAuthCode returns the just-seeded row
  PASS: freshly seeded code is unused
  PASS: freshly seeded code is unexpired
  PASS: hashing the correct code matches the stored hash
  PASS: code is marked used_at after successful verification
  PASS: a valid sessions row exists for the new session token hash
  PASS: a code cannot be re-verified: used_at is set, so a second attempt would be rejected as "already used"
3. Incorrect code increments attempt_count, 5th invalidates:
  PASS: the chosen wrong code does not hash-match the real code
  PASS: attempt_count is 1 after 1 incorrect attempt(s)
  PASS: attempt_count is 2 after 2 incorrect attempt(s)
  PASS: attempt_count is 3 after 3 incorrect attempt(s)
  PASS: attempt_count is 4 after 4 incorrect attempt(s)
  PASS: code is still active after 4 failed attempts
  PASS: attempt_count reaches 5 after the 5th incorrect attempt
  PASS: code is invalidated (used_at set) once attempt_count hits 5
4. Expired code is rejected without incrementing attempts:
  PASS: the expired row is the latest row
  PASS: the seeded row is indeed expired
  PASS: attempt_count starts at 0 and the endpoint must not increment it for an expired code

Cleaning up test rows...
  PASS: all test auth_codes rows were cleaned up

20 passed, 0 failed
```

Manual live verification (not re-executed by `showboat verify` since it requires a running dev server plus DB seed/cleanup around it): with the dev server running, a code (654321) was seeded directly via createAuthCode/invalidateActiveAuthCodes. POSTing an incorrect code to /api/auth/verify-code returned `400 {"error":"Incorrect code."}` with no cookie set. POSTing the correct code returned `200 {"ok":true}` with a `set-cookie: session=<64-hex-char token>; Path=/; Expires=...; HttpOnly; Secure; SameSite=Lax` header — confirming the cookie is httpOnly, Secure, and SameSite=Lax as required. Re-POSTing the same correct code afterward returned `400 {"error":"This code has already been used. Please request a new code."}`, confirming a code cannot be reused. The seeded test row was deleted by id afterward to leave the live Turso DB clean.
