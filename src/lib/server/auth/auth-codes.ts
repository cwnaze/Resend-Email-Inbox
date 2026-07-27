// Drizzle query helpers for the `auth_codes` table (US-B01).
//
// These accept a database handle as their first argument (typed from `db`'s
// own type, via `import type`) rather than importing the `db` singleton
// directly. `import type` only pulls the type — it does not execute
// `src/lib/server/db/index.ts` — so this module has no `$env/dynamic/private`
// dependency and can be exercised by a standalone verification script
// (see `src/lib/server/auth/verify-auth-sessions.mts`) using a plain
// `drizzle(createClient(...))` instance built from `process.env`, the same
// pattern used for other standalone infra scripts in this repo. Real app
// code (US-B02/US-B03) should import the `db` singleton from
// `$lib/server/db` and pass it in here.
//
// Business rules encoded here, per tasks/prd-data-model.md and
// agents/prd.json (US-B02/US-B03):
//   - Only one auth code is "active" (unused, unexpired) at a time.
//   - Requesting a new code invalidates any still-active previous code.
//   - Failed verification attempts increment `attempt_count`; 5 failures
//     invalidates the code (US-B03) — that threshold check lives in the
//     verify-code endpoint itself, this module just persists the count.
import { createHash } from 'node:crypto';
import { and, count, desc, eq, gt, gte, isNull, min, sql } from 'drizzle-orm';
import { authCodes } from '../db/schema';
import type { Database } from '../db/types';

/**
 * Hashes a plaintext login code for storage/comparison. The only hash function
 * that may ever touch `auth_codes.code_hash` — the entire security property is
 * that the request-code and verify-code paths hash identically, and a divergence
 * between two copies of this one-liner would fail silently and permanently as
 * "wrong code".
 *
 * Deliberately a plain SHA-256 rather than an HMAC keyed with a server secret:
 * a 6-digit code has only a 10^6 preimage space, so an attacker holding the
 * `auth_codes` table can brute-force the hash trivially either way. The
 * 10-minute TTL and 5-attempt cap are what make that mostly theoretical; if we
 * ever want the hash column to be worthless on its own, switch this to an HMAC
 * (both call sites go through here, so it's a one-line change).
 */
export function hashAuthCode(code: string): string {
	return createHash('sha256').update(code).digest('hex');
}

/** Inserts a new auth_codes row and returns it. */
export async function createAuthCode(database: Database, codeHash: string, expiresAt: Date) {
	const [row] = await database.insert(authCodes).values({ codeHash, expiresAt }).returning();
	return row;
}

/**
 * Returns the current active (unused, unexpired) auth code, if any, most
 * recently created first. Only one should ever exist at a time in practice
 * (see `invalidateActiveAuthCodes`), but ordering guards against that
 * invariant being violated.
 */
export async function getActiveAuthCode(database: Database, now: Date = new Date()) {
	const rows = await database
		.select()
		.from(authCodes)
		.where(and(isNull(authCodes.usedAt), gt(authCodes.expiresAt, now)))
		.orderBy(desc(authCodes.createdAt))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Expires every currently active (unused, unexpired) auth code, so a newly
 * requested code becomes the only active one. Returns the number of rows
 * superseded.
 *
 * This pulls `expires_at` back to `now` rather than setting `used_at`, so
 * "superseded because a newer code was requested" stays distinguishable from
 * "consumed by a successful login" (`used_at IS NOT NULL`). That keeps
 * `auth_codes` answerable for "was this code ever redeemed?" (audit, debugging
 * a login complaint) and lets US-B03 report the accurate reason — a superseded
 * code reads as expired, not as already used.
 */
export async function invalidateActiveAuthCodes(database: Database, now: Date = new Date()) {
	const rows = await database
		.update(authCodes)
		.set({ expiresAt: now })
		.where(and(isNull(authCodes.usedAt), gt(authCodes.expiresAt, now)))
		.returning({ id: authCodes.id });
	return rows.length;
}

/**
 * Kills a single auth code by pulling `expires_at` back to `now`, without
 * touching `used_at`. Same mechanism as `invalidateActiveAuthCodes`, scoped to
 * one row.
 *
 * US-B03 uses this for the 5-attempt lockout: a code burned by wrong guesses
 * was never redeemed, so stamping `used_at` on it would both corrupt the
 * "was this code ever redeemed?" answer and make verify-code report "already
 * used" for a code the user never successfully entered. Expiring it produces
 * the accurate error copy and keeps `used_at IS NOT NULL` meaning exactly one
 * thing.
 */
export async function expireAuthCode(database: Database, id: string, now: Date = new Date()) {
	const [row] = await database
		.update(authCodes)
		.set({ expiresAt: now })
		.where(eq(authCodes.id, id))
		.returning();
	return row;
}

/**
 * Marks a specific auth code row as used (successful verification).
 *
 * The `used_at IS NULL` guard makes this an atomic compare-and-swap: exactly
 * one caller can consume a given code. A returned `undefined` means the code
 * was already used by someone else and this caller must reject — without that,
 * two requests carrying the same correct code could both pass a
 * read-then-check and both mint a session (US-B03).
 */
export async function markAuthCodeUsed(database: Database, id: string, usedAt: Date = new Date()) {
	const [row] = await database
		.update(authCodes)
		.set({ usedAt })
		.where(and(eq(authCodes.id, id), isNull(authCodes.usedAt)))
		.returning();
	return row;
}

/**
 * Rate-limit window stats for `auth_codes`: how many rows were created at/after
 * `windowStart`, and the `createdAt` of the oldest one (or `null` if none).
 *
 * The count is "how many code *requests* happened in the rolling window",
 * regardless of whether those codes have since been used/superseded/expired —
 * a rate-limited request must not insert a row, so it reflects only genuine
 * requests. The oldest timestamp is the one that will next age out of the
 * window, which is what a "try again in N minutes" message and the
 * `Retry-After` header are measured from (US-B04).
 *
 * Both come back from a single aggregate so the throttled path costs one round
 * trip rather than two, and so the two numbers can't be read from different
 * moments.
 */
export async function getAuthCodeRequestWindow(database: Database, windowStart: Date) {
	const rows = await database
		.select({ value: count(), oldest: min(authCodes.createdAt) })
		.from(authCodes)
		.where(gte(authCodes.createdAt, windowStart));
	const row = rows[0];
	return {
		count: row?.value ?? 0,
		// drizzle's `timestamp_ms` mapping applies to selected columns, not to
		// aggregate expressions over them, so SQLite's `min()` comes back as a raw
		// number — rewrap it.
		oldestCreatedAt: row?.oldest != null ? new Date(Number(row.oldest)) : null
	};
}

/**
 * Returns the single most-recently-created auth_codes row, regardless of
 * used/expired state, or `null` if none exist. US-B03 (verify-code) uses
 * this — rather than `getActiveAuthCode` — because it needs to distinguish
 * "no code exists", "code exists but is used", and "code exists but is
 * expired" so it can return the right error message and correctly skip
 * incrementing `attempt_count` against a dead (used/expired) code.
 */
export async function getLatestAuthCode(database: Database) {
	const rows = await database.select().from(authCodes).orderBy(desc(authCodes.createdAt)).limit(1);
	return rows[0] ?? null;
}

/**
 * Deletes a single auth_codes row by id.
 *
 * Used to roll back a just-created code when the email carrying it could not be
 * sent: the plaintext exists only in the request that generated it, so a row
 * whose code was never delivered is unusable — leaving it behind would keep
 * consuming a rate-limit slot and (having superseded the previous code) leave
 * the user with no valid code at all.
 */
export async function deleteAuthCode(database: Database, id: string) {
	await database.delete(authCodes).where(eq(authCodes.id, id));
}

/**
 * Increments the failed-attempt counter for a specific auth code row.
 *
 * The arithmetic happens in SQL so the whole thing is one atomic statement.
 * A JS read-modify-write would let two concurrent wrong-code submissions both
 * read the same count and both write count+1, and the lost update would let an
 * attacker walk past US-B03's 5-attempt lockout by guessing in parallel —
 * concurrent requests being exactly the attacker's access pattern.
 */
export async function incrementAuthCodeAttempts(database: Database, id: string) {
	const [row] = await database
		.update(authCodes)
		.set({ attemptCount: sql`${authCodes.attemptCount} + 1` })
		.where(eq(authCodes.id, id))
		.returning();
	return row;
}
