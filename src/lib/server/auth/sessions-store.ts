// Drizzle query helpers for the `sessions` table (US-B01).
//
// Named `sessions-store.ts` (not `sessions.ts`) to avoid confusion with the
// existing `session.ts` in this directory, which only holds the session
// cookie name/presence-check helper used by route protection (US-A03) — that
// file is untouched here and keeps doing its job until US-B05 wires real
// session validation into `(app)/+layout.server.ts`.
//
// Like `auth-codes.ts`, these accept a database handle as their first
// argument (typed via `import type` of the `db` singleton) so this module
// has no `$env/dynamic/private` dependency and can be exercised by the
// standalone `verify-auth-sessions.mts` script as well as real app code.
import { and, eq, gt } from 'drizzle-orm';
import type { db as dbSingleton } from '../db';
import { sessions } from '../db/schema';

export type Database = typeof dbSingleton;

/** Inserts a new sessions row (given the hash of the raw session token) and returns it. */
export async function createSession(database: Database, tokenHash: string, expiresAt: Date) {
	const [row] = await database.insert(sessions).values({ tokenHash, expiresAt }).returning();
	return row;
}

/** Returns the session row for a token hash if it exists and is not expired. */
export async function getValidSessionByTokenHash(
	database: Database,
	tokenHash: string,
	now: Date = new Date()
) {
	const rows = await database
		.select()
		.from(sessions)
		.where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)));
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
