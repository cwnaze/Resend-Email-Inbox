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
import { and, count, desc, eq, gt, gte, isNull, sql } from 'drizzle-orm';
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
 * Counts how many auth_codes rows were created at/after `windowStart` —
 * i.e. how many code *requests* have happened in the rolling window,
 * regardless of whether that code has since been used/invalidated/expired.
 * Used by US-B02 to enforce "no more than 3 requests per 10-minute rolling
 * window" — a request that gets rate-limited must not insert a row, so this
 * count reflects only genuine requests.
 */
export async function countAuthCodeRequestsSince(database: Database, windowStart: Date) {
	const rows = await database
		.select({ value: count() })
		.from(authCodes)
		.where(gte(authCodes.createdAt, windowStart));
	return rows[0]?.value ?? 0;
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
