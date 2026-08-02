// Standalone smoke-test script for US-B01 (auth_codes/sessions schema wiring).
//
// Exercises the real Drizzle query helpers in `auth-codes.ts` and
// `sessions-store.ts` against the live Turso database: create/read/update
// flows for both tables, confirming the queries compile and run correctly
// against the migrated schema (not just that the tables exist, which US-D01
// already verified).
//
// Standalone (not importing `src/lib/server/db/index.ts`) because
// `$env/dynamic/private` only resolves inside a Vite/SvelteKit runtime — same
// pattern as `src/lib/server/db/verify-schema.mts` (US-D01) and
// `src/lib/server/r2/verify.mts` (US-A02). Builds its own `drizzle(client)`
// instance from `process.env` instead, then calls the exact same query
// helper functions real app code will use, passing that instance in.
//
// NOTE: this writes to the same Turso instance the app uses — there is no
// separate test database. It only creates rows it then deletes (in the
// `finally` block below, so debris doesn't survive an unexpected throw), but
// "run the verify script" is not a read-only operation.
//
// Run via: node --env-file=.env node_modules/.bin/tsx src/lib/server/auth/verify-auth-sessions.mts
import type { Cookies } from '@sveltejs/kit';
import { createClient } from '@libsql/client';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../db/schema.js';
import {
	createAuthCode,
	createAuthCodeWithinRateLimit,
	getActiveAuthCode,
	getAuthCodeRequestWindow,
	incrementAuthCodeAttempts,
	invalidateActiveAuthCodes,
	markAuthCodeUsed
} from './auth-codes.js';
import {
	createSession,
	deleteSessionByTokenHash,
	extendSessionExpiry,
	getValidSessionByTokenHash,
	hashSessionToken
} from './sessions-store.js';
import { SESSION_TTL_MS, destroySession, validateSession } from './session.js';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
	throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must both be set to run this script.');
}

const client = createClient({ url, authToken });
const db = drizzle(client, { schema });

function check(label: string, condition: boolean) {
	console.log(condition ? `PASS: ${label}` : `FAIL: ${label}`);
	if (!condition) process.exitCode = 1;
}

// Every auth_codes row this script inserts, recorded as it is created so the
// `finally` cleanup can remove them even if an assertion above it throws.
const createdAuthCodeIds: string[] = [];

/** Every sessions token_hash this script inserts, for the same reason. */
const trackedSessionHashes: string[] = ['hash-of-session-token'];

/**
 * Minimal stand-in for SvelteKit's `Cookies`, recording writes so the tests can
 * assert that `validateSession`/`destroySession` set and clear the cookie. Only
 * the three methods those two functions actually call are implemented, so it is
 * cast to `Cookies` rather than claiming to satisfy the full interface.
 */
function fakeCookies(jar: Record<string, string>) {
	const store = { ...jar };
	const setCalls: { value: string; expires?: Date }[] = [];
	const deleteCalls: string[] = [];
	return {
		get: (name: string) => store[name],
		set: (name: string, value: string, options: { expires?: Date }) => {
			store[name] = value;
			setCalls.push({ value, expires: options.expires });
		},
		delete: (name: string) => {
			delete store[name];
			deleteCalls.push(name);
		},
		setCalls,
		deleteCalls
	} as unknown as Cookies & { setCalls: typeof setCalls; deleteCalls: string[] };
}

async function trackAuthCode(codeHash: string, expiresAt: Date) {
	const row = await createAuthCode(db, codeHash, expiresAt);
	if (row) createdAuthCodeIds.push(row.id);
	return row;
}

try {
	// --- auth_codes ---

	const now = new Date();
	const tenMinutes = 10 * 60 * 1000;

	const first = await trackAuthCode('hash-of-first-code', new Date(now.getTime() + tenMinutes));
	check(
		'createAuthCode inserts a row',
		first !== undefined && first.codeHash === 'hash-of-first-code'
	);

	const active1 = await getActiveAuthCode(db, now);
	check('getActiveAuthCode finds the freshly created code', active1?.id === first.id);

	// Requesting a second code supersedes the first (only one active at a time).
	const invalidatedCount = await invalidateActiveAuthCodes(db, now);
	check('invalidateActiveAuthCodes supersedes the prior active code', invalidatedCount === 1);

	const afterInvalidate = await getActiveAuthCode(db, now);
	check('no active code remains after invalidation', afterInvalidate === null);

	// --- createAuthCodeWithinRateLimit: the check and the insert must be one
	// statement, or concurrent unauthenticated POSTs all read the same
	// pre-insert count and all send an email.
	//
	// The limit is expressed relative to whatever is already in the window so
	// this test is self-contained against the shared database: allow exactly two
	// more than the current count, fire ten inserts at once, and require that
	// exactly two win.
	const windowStart = new Date(now.getTime() - tenMinutes);
	const { count: baseline } = await getAuthCodeRequestWindow(db, windowStart);
	const burst = await Promise.all(
		Array.from({ length: 10 }, (_, i) =>
			createAuthCodeWithinRateLimit(
				db,
				`hash-of-burst-code-${i}`,
				new Date(now.getTime() + tenMinutes),
				windowStart,
				baseline + 2
			)
		)
	);
	const admitted = burst.filter((id): id is string => id !== null);
	createdAuthCodeIds.push(...admitted);
	check(
		'createAuthCodeWithinRateLimit admits exactly the remaining quota under a concurrent burst',
		admitted.length === 2
	);
	const { count: afterBurst } = await getAuthCodeRequestWindow(db, windowStart);
	check(
		'the burst wrote exactly as many rows as it reported admitting',
		afterBurst === baseline + admitted.length
	);
	check(
		'createAuthCodeWithinRateLimit returns null once the window is full',
		(await createAuthCodeWithinRateLimit(
			db,
			'hash-of-over-limit-code',
			new Date(now.getTime() + tenMinutes),
			windowStart,
			baseline + 2
		)) === null
	);

	// The endpoint creates the replacement code *before* superseding the old
	// one, so the exemption is what stops it expiring the code it just minted.
	const keptId = admitted[0];
	await invalidateActiveAuthCodes(db, now, keptId);
	const stillActive = await getActiveAuthCode(db, now);
	check('invalidateActiveAuthCodes leaves the exempted row active', stillActive?.id === keptId);
	await invalidateActiveAuthCodes(db, now);

	// A superseded code must stay distinguishable from a redeemed one: it is
	// expired, not used, so US-B03 can report the accurate reason.
	const supersededRows = await db
		.select({ usedAt: schema.authCodes.usedAt })
		.from(schema.authCodes)
		.where(eq(schema.authCodes.id, first.id));
	check(
		'a superseded code has used_at still NULL (expired, not redeemed)',
		supersededRows[0]?.usedAt === null
	);

	const second = await trackAuthCode('hash-of-second-code', new Date(now.getTime() + tenMinutes));
	const active2 = await getActiveAuthCode(db, now);
	check('getActiveAuthCode finds the second code', active2?.id === second.id);

	const afterAttempt = await incrementAuthCodeAttempts(db, second.id);
	check('incrementAuthCodeAttempts bumps attempt_count to 1', afterAttempt?.attemptCount === 1);

	// Concurrent increments must not lose updates (the counter backs US-B03's
	// 5-attempt lockout, so it has to survive parallel wrong-code submissions).
	await Promise.all([
		incrementAuthCodeAttempts(db, second.id),
		incrementAuthCodeAttempts(db, second.id),
		incrementAuthCodeAttempts(db, second.id),
		incrementAuthCodeAttempts(db, second.id)
	]);
	const afterConcurrent = await db
		.select({ attemptCount: schema.authCodes.attemptCount })
		.from(schema.authCodes)
		.where(eq(schema.authCodes.id, second.id));
	check(
		'four concurrent increments all land (attempt_count === 5)',
		afterConcurrent[0]?.attemptCount === 5
	);

	const usedRow = await markAuthCodeUsed(db, second.id, now);
	check('markAuthCodeUsed sets used_at', usedRow?.usedAt !== null && usedRow?.usedAt !== undefined);

	// Compare-and-swap: only the first caller consumes the code.
	const usedTwice = await markAuthCodeUsed(db, second.id, now);
	check('markAuthCodeUsed returns undefined for an already-used code', usedTwice === undefined);

	const afterUse = await getActiveAuthCode(db, now);
	check('getActiveAuthCode returns null once the code is used', afterUse === null);

	// Expiry: a code created already expired must not be "active".
	await trackAuthCode('hash-of-expired-code', new Date(now.getTime() - 1000));
	const activeAfterExpired = await getActiveAuthCode(db, now);
	check('an expired code is not returned as active', activeAfterExpired === null);

	// --- sessions ---

	const sessionExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
	const session = await createSession(db, 'hash-of-session-token', sessionExpiresAt);
	check(
		'createSession inserts a row',
		session !== undefined && session.tokenHash === 'hash-of-session-token'
	);

	const validSession = await getValidSessionByTokenHash(db, 'hash-of-session-token', now);
	check('getValidSessionByTokenHash finds the unexpired session', validSession?.id === session.id);

	const expiredSessionCheck = await getValidSessionByTokenHash(
		db,
		'hash-of-session-token',
		new Date(sessionExpiresAt.getTime() + 1000)
	);
	check(
		'getValidSessionByTokenHash returns null once past expires_at',
		expiredSessionCheck === null
	);

	const newExpiry = new Date(now.getTime() + 48 * 60 * 60 * 1000);
	const extended = await extendSessionExpiry(db, 'hash-of-session-token', newExpiry);
	check(
		'extendSessionExpiry updates expires_at (sliding expiration)',
		extended?.expiresAt?.getTime() === newExpiry.getTime()
	);

	const deleted = await deleteSessionByTokenHash(db, 'hash-of-session-token');
	check('deleteSessionByTokenHash removes the row', deleted === true);

	const afterDelete = await getValidSessionByTokenHash(db, 'hash-of-session-token', now);
	check('session no longer found after delete', afterDelete === null);

	const deletedAgain = await deleteSessionByTokenHash(db, 'hash-of-session-token');
	check('deleteSessionByTokenHash returns false when nothing to delete', deletedAgain === false);

	// --- session.ts: validateSession / destroySession (US-B05) ---
	//
	// These take a `Cookies` handle, which only exists inside a SvelteKit
	// request; `fakeCookies` below stands in for it. The point of exercising them
	// here rather than only through the HTTP layer is that the refresh/expiry
	// arithmetic is time-dependent — passing an explicit `now` lets us assert the
	// sliding-expiration branch without waiting 15 days.
	const rawToken = 'b05-raw-session-token';
	const rawTokenHash = hashSessionToken(rawToken);
	trackedSessionHashes.push(rawTokenHash);

	const freshExpiry = new Date(now.getTime() + SESSION_TTL_MS);
	await createSession(db, rawTokenHash, freshExpiry);

	const cookies = fakeCookies({ session: rawToken });
	const valid = await validateSession(db, cookies, now);
	check('validateSession accepts a live token (hashes the cookie, finds the row)', valid !== null);
	check(
		'a fresh session is not refreshed (no cookie re-set, expires_at unchanged)',
		cookies.setCalls.length === 0 && valid?.expiresAt.getTime() === freshExpiry.getTime()
	);

	// Past the halfway point of the TTL, an active request slides the expiry
	// forward and re-sets the cookie so the browser copy matches the row.
	const later = new Date(now.getTime() + SESSION_TTL_MS / 2 + 1000);
	const refreshed = await validateSession(db, cookies, later);
	check(
		'validateSession slides expires_at forward past the halfway point',
		refreshed !== null && refreshed.expiresAt.getTime() > freshExpiry.getTime()
	);
	check(
		'the refreshed session cookie is re-set with the new expiry',
		cookies.setCalls.length === 1
	);

	check(
		'validateSession rejects an unknown token',
		(await validateSession(db, fakeCookies({ session: 'not-a-real-token' }), now)) === null
	);
	check(
		'validateSession rejects a request with no cookie at all',
		(await validateSession(db, fakeCookies({}), now)) === null
	);

	const expiredHash = hashSessionToken('b05-expired-session-token');
	trackedSessionHashes.push(expiredHash);
	await createSession(db, expiredHash, new Date(now.getTime() - 1000));
	check(
		'validateSession rejects an expired session',
		(await validateSession(db, fakeCookies({ session: 'b05-expired-session-token' }), now)) === null
	);

	// Logout: the row must actually go away, not just the cookie (FR-8).
	const logoutCookies = fakeCookies({ session: rawToken });
	check(
		'destroySession deletes the sessions row',
		(await destroySession(db, logoutCookies)) === true
	);
	check('destroySession clears the session cookie', logoutCookies.deleteCalls.includes('session'));
	check(
		'the deleted session no longer validates',
		(await validateSession(db, fakeCookies({ session: rawToken }), now)) === null
	);
	check(
		'destroySession reports false when there was no session to delete',
		(await destroySession(db, fakeCookies({}))) === false
	);
} finally {
	// --- cleanup ---
	// Runs even if an assertion above threw, so a failed run never leaves test
	// rows behind in the shared database and the client is always closed.
	if (createdAuthCodeIds.length > 0) {
		await db.delete(schema.authCodes).where(inArray(schema.authCodes.id, createdAuthCodeIds));
	}
	for (const tokenHash of trackedSessionHashes) {
		await deleteSessionByTokenHash(db, tokenHash);
	}
	await client.close();
}
