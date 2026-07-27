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
import { and, count, desc, eq, gt, gte, isNull } from 'drizzle-orm';
import type { db as dbSingleton } from '../db';
import { authCodes } from '../db/schema';

export type Database = typeof dbSingleton;

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
 * Marks every currently active (unused, unexpired) auth code as used, so a
 * newly requested code becomes the only active one. Returns the number of
 * rows invalidated.
 */
export async function invalidateActiveAuthCodes(database: Database, now: Date = new Date()) {
	const rows = await database
		.update(authCodes)
		.set({ usedAt: now })
		.where(and(isNull(authCodes.usedAt), gt(authCodes.expiresAt, now)))
		.returning({ id: authCodes.id });
	return rows.length;
}

/** Marks a specific auth code row as used (successful verification). */
export async function markAuthCodeUsed(database: Database, id: string, usedAt: Date = new Date()) {
	const [row] = await database
		.update(authCodes)
		.set({ usedAt })
		.where(eq(authCodes.id, id))
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

/** Increments the failed-attempt counter for a specific auth code row. */
export async function incrementAuthCodeAttempts(database: Database, id: string) {
	const current = await database
		.select({ attemptCount: authCodes.attemptCount })
		.from(authCodes)
		.where(eq(authCodes.id, id));
	const next = (current[0]?.attemptCount ?? 0) + 1;
	const [row] = await database
		.update(authCodes)
		.set({ attemptCount: next })
		.where(eq(authCodes.id, id))
		.returning();
	return row;
}
