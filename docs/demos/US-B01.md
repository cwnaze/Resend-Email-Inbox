# Auth codes and sessions schema wiring

*2026-07-27T12:52:18Z by Showboat 0.6.1*
<!-- showboat-id: 5f6bb5a0-f6fe-4c10-8a8f-d8074584a533 -->

Verified the auth_codes and sessions tables (defined in US-D01) by exercising real Drizzle query helpers against the live Turso database: createAuthCode/getActiveAuthCode/invalidateActiveAuthCodes/incrementAuthCodeAttempts/markAuthCodeUsed for auth_codes, and createSession/getValidSessionByTokenHash/extendSessionExpiry/deleteSessionByTokenHash for sessions. Helpers live in src/lib/server/auth/auth-codes.ts and src/lib/server/auth/sessions-store.ts, dependency-injected on a db handle so the same functions run in the app (later stories) and in this standalone verification script.

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/auth/verify-auth-sessions.mts
```

```output
PASS: createAuthCode inserts a row
PASS: getActiveAuthCode finds the freshly created code
PASS: invalidateActiveAuthCodes invalidates the prior active code
PASS: no active code remains after invalidation
PASS: getActiveAuthCode finds the second code
PASS: incrementAuthCodeAttempts bumps attempt_count to 1
PASS: markAuthCodeUsed sets used_at
PASS: getActiveAuthCode returns null once the code is used
PASS: an expired code is not returned as active
PASS: createSession inserts a row
PASS: getValidSessionByTokenHash finds the unexpired session
PASS: getValidSessionByTokenHash returns null once past expires_at
PASS: extendSessionExpiry updates expires_at (sliding expiration)
PASS: deleteSessionByTokenHash removes the row
PASS: session no longer found after delete
PASS: deleteSessionByTokenHash returns false when nothing to delete
```

```bash
npm run check 2>&1 | sed -E 's/^[0-9]{10,} //'
```

```output

> resend-email-inbox@0.0.1 check
> svelte-kit sync && svelte-check --tsconfig ./tsconfig.json

START "/Users/bloodintern1/Desktop/Resend-Email-Inbox"
COMPLETED 1186 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```

```bash
npm run lint 2>&1
```

```output

> resend-email-inbox@0.0.1 lint
> prettier --check . && eslint .

Checking formatting...
All matched files use Prettier code style!
```
