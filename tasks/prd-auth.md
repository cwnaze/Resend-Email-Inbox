# PRD: Auth — One-Button Email Code Login

## Introduction

A single-user authentication flow with no password and no email-entry field. The user clicks one button; a 6-digit code is emailed to a hardcoded address; entering the correct code establishes a session. There is no enumeration surface because the recipient is never derived from user input.

## Goals

- Zero-friction login for the one legitimate user
- No attack surface for account enumeration, credential stuffing, or recipient spoofing
- Codes expire quickly, are single-use, and are rate-limited to prevent abuse/spam
- Sessions are secure, httpOnly, and appropriately scoped

## User Stories

### US-B01: Auth codes and sessions schema
**Description:** As a developer, I need tables for auth codes and sessions so the login flow has somewhere to persist state.

**Acceptance Criteria:**
- [ ] `auth_codes` table exists per Data Model PRD (code hash, created_at, expires_at, used_at, attempt_count)
- [ ] `sessions` table exists per Data Model PRD (session id/token hash, created_at, expires_at)
- [ ] Drizzle migration applies cleanly
- [ ] Typecheck passes

### US-B02: "Send me a code" endpoint with rate limiting
**Description:** As the app owner, I want clicking the login button to email me a 6-digit code, so I can authenticate without a password.

**Acceptance Criteria:**
- [ ] `POST /api/auth/request-code` generates a cryptographically random 6-digit code
- [ ] The code is hashed (e.g., SHA-256) before storage; the raw code is never persisted
- [ ] A row is inserted into `auth_codes` with `expires_at` = now + 10 minutes
- [ ] The email is sent via Resend from `auth@caseynazelrod.com` to the constant `AUTH_RECIPIENT_EMAIL` (`cwnaze@gmail.com`) — this address is never read from request input
- [ ] Rate limiting: no more than 3 code requests per 10-minute rolling window; the 4th+ request in that window returns `429` without sending an email or creating a new code row
- [ ] Any previously unused, unexpired code for this single-user app is invalidated when a new one is requested (only one active code at a time)
- [ ] Typecheck passes

### US-B03: Verify-code endpoint and session creation
**Description:** As the app owner, I want to enter the 6-digit code and be logged in, so I can access my inbox.

**Acceptance Criteria:**
- [ ] `POST /api/auth/verify-code` accepts a 6-digit code, hashes it, and compares against the active unexpired, unused `auth_codes` row
- [ ] On match: marks the code row `used_at = now()`, creates a `sessions` row, and sets an httpOnly, `Secure`, `SameSite=Lax` session cookie containing only an opaque session token (not the code, not a JWT with sensitive claims)
- [ ] On mismatch: increments `attempt_count`; after 5 failed attempts against a given code, that code is invalidated and the user must request a new one
- [ ] Expired codes are rejected with a clear error and do not increment attempt count against a dead code
- [ ] A code cannot be used twice (checking `used_at IS NULL` at verification time)
- [ ] Typecheck passes

### US-B04: Login page UI — single button and code entry
**Description:** As the app owner, I want a minimal login screen: one button, then a code field, so login is fast and matches the Dusk Terminal aesthetic.

**Acceptance Criteria:**
- [ ] `/login` renders centered app mark + single "Send me a code" button (no email input field anywhere on the page)
- [ ] Clicking the button calls the request-code endpoint and transitions the UI to a 6-digit code entry step (monospace input)
- [ ] Submitting an incorrect code shows an inline error without navigating away
- [ ] Submitting a valid code redirects to `/inbox`
- [ ] Rate-limit (`429`) responses show a clear "try again in N minutes" message
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-B05: Route protection and logout
**Description:** As the app owner, I want all mailbox routes to require a valid session, and a way to log out, so my inbox stays private.

**Acceptance Criteria:**
- [ ] `(app)` layout server load rejects requests with missing/expired/invalid session cookie and redirects to `/login`
- [ ] `POST /api/auth/logout` clears the session cookie and deletes the corresponding `sessions` row
- [ ] A visible logout action exists in the app shell
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: The recipient of every auth-code email must be the server-side constant `AUTH_RECIPIENT_EMAIL`; no code path may accept or use a client-supplied recipient.
- FR-2: Codes must be 6 digits, generated with a CSPRNG, and stored only as a salted hash.
- FR-3: Codes expire 10 minutes after creation.
- FR-4: Codes are single-use; a used code is permanently rejected on subsequent verify attempts.
- FR-5: Code requests are rate-limited to 3 per 10-minute rolling window per deployment (no per-IP/user dimension needed since there is only one user).
- FR-6: Failed verification attempts are capped at 5 per code before that code is invalidated.
- FR-7: Session cookies must be httpOnly, `Secure`, and `SameSite=Lax` at minimum.
- FR-8: Sessions must have a server-side record (in `sessions` table) so they can be individually revoked (e.g., via logout), not purely stateless JWTs.
- FR-9: Session lifetime defaults to 30 days from creation, refreshed on activity (sliding expiration), unless explicitly logged out.

## Non-Goals

- No "remember me" toggle — all sessions behave the same way (30-day sliding expiration).
- No password-based fallback login method.
- No multi-factor beyond the single email code (email possession is itself the sole factor, appropriate for a single-user personal tool).
- No account recovery flow — there is no account to recover; if the recipient inbox is lost, redeploying with updated env vars is the recovery path.

## Design Considerations

- Login screen matches Dusk Terminal: `#12141C` background, centered app mark, single accent-colored (`#7FB4A6`) button with sharp corners (2–4px radius).
- Code entry field uses the monospace typeface, large legible digit spacing.

## Technical Considerations

- Rate limiting can be implemented via a simple counter column/row in `auth_codes` (count requests in the last 10 minutes) rather than requiring a separate Redis/KV store, given single-user scale.
- Session token: generate a random 32-byte value, store only its hash in `sessions`, set the raw value in the cookie — mirrors the code-hashing pattern to avoid a stolen DB row being directly usable as a session token.

## Success Metrics

- Legitimate login (click → email arrives → code entered) completes in under 60 seconds in manual testing.
- Automated adversarial test: 4th rapid code request within 10 minutes is rejected with 429.
- Automated adversarial test: reusing a already-verified code is rejected.

## Open Questions

- Should there be an email notification/alert if 5 failed verify attempts occur (possible attempted intrusion)? (Assumption: nice-to-have, not required for v1 given the tiny attack surface.)
