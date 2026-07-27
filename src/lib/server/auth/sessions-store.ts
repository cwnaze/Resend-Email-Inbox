// Drizzle query helpers for the `sessions` table (US-B01).
//
// Named `sessions-store.ts` (not `sessions.ts`) to avoid confusion with
// `session.ts` in this directory. The split is table vs. cookie: this module
// owns the `sessions` *table* (raw queries, no notion of a request), while
// `session.ts` owns the session *cookie* and the request-level lifecycle built
// on these helpers — `validateSession` and `destroySession` (US-B05) both call
// into here. Keep new table queries here and new cookie/request logic there.
//
// Like `auth-codes.ts`, these accept a database handle as their first
// argument (typed via `import type` of the `db` singleton) so this module
// has no `$env/dynamic/private` dependency and can be exercised by the
// standalone `verify-auth-sessions.mts` script as well as real app code.
import { createHash } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { sessions } from '../db/schema';
import type { Database } from '../db/types';

/**
 * Hashes a raw session token for storage/lookup — the only hash function that
 * may touch `sessions.token_hash`. Deliberately separate from
 * `hashAuthCode` in `auth-codes.ts` despite the identical implementation: the
 * two hash different secrets with different threat models (a 32-byte random
 * token has no brute-forceable preimage space, a 6-digit code does), so
 * changing one — e.g. keying the code hash with an HMAC — must not silently
 * change the other. Callers hash through this function rather than re-inlining
 * it (see `validateSession`/`destroySession` in `session.ts`).
 */
export function hashSessionToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/** Inserts a new sessions row (given the hash of the raw session token) and returns it. */
export async function createSession(database: Database, tokenHash: string, expiresAt: Date) {
	const [row] = await database.insert(sessions).values({ tokenHash, expiresAt }).returning();
	return row;
}

/**
 * Returns the session row for a token hash if it exists and is not expired.
 * `sessions.token_hash` carries a unique index (`sessions_token_hash_unique`),
 * so at most one row can match; `.limit(1)` just makes that explicit.
 */
export async function getValidSessionByTokenHash(
	database: Database,
	tokenHash: string,
	now: Date = new Date()
) {
	const rows = await database
		.select()
		.from(sessions)
		.where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
		.limit(1);
	return rows[0] ?? null;
}

/** Extends a session's expiry (sliding expiration, per tasks/prd-data-model.md). */
export async function extendSessionExpiry(database: Database, tokenHash: string, expiresAt: Date) {
	const [row] = await database
		.update(sessions)
		.set({ expiresAt })
		.where(eq(sessions.tokenHash, tokenHash))
		.returning();
	return row;
}

/** Deletes a session row by token hash (logout). Returns true if a row was deleted. */
export async function deleteSessionByTokenHash(database: Database, tokenHash: string) {
	const rows = await database
		.delete(sessions)
		.where(eq(sessions.tokenHash, tokenHash))
		.returning({ id: sessions.id });
	return rows.length > 0;
}
