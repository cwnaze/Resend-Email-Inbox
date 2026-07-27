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
// Run via: node --env-file=.env node_modules/.bin/tsx src/lib/server/auth/verify-auth-sessions.mts
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../db/schema.js';
import {
	createAuthCode,
	getActiveAuthCode,
	incrementAuthCodeAttempts,
	invalidateActiveAuthCodes,
	markAuthCodeUsed
} from './auth-codes.js';
import {
	createSession,
	deleteSessionByTokenHash,
	extendSessionExpiry,
	getValidSessionByTokenHash
} from './sessions-store.js';

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

// --- auth_codes ---

const now = new Date();
const tenMinutes = 10 * 60 * 1000;

const first = await createAuthCode(db, 'hash-of-first-code', new Date(now.getTime() + tenMinutes));
check(
	'createAuthCode inserts a row',
	first !== undefined && first.codeHash === 'hash-of-first-code'
);

const active1 = await getActiveAuthCode(db, now);
check('getActiveAuthCode finds the freshly created code', active1?.id === first.id);

// Requesting a second code invalidates the first (only one active at a time).
const invalidatedCount = await invalidateActiveAuthCodes(db, now);
check('invalidateActiveAuthCodes invalidates the prior active code', invalidatedCount === 1);

const afterInvalidate = await getActiveAuthCode(db, now);
check('no active code remains after invalidation', afterInvalidate === null);

const second = await createAuthCode(
	db,
	'hash-of-second-code',
	new Date(now.getTime() + tenMinutes)
);
const active2 = await getActiveAuthCode(db, now);
check('getActiveAuthCode finds the second code', active2?.id === second.id);

const afterAttempt = await incrementAuthCodeAttempts(db, second.id);
check('incrementAuthCodeAttempts bumps attempt_count to 1', afterAttempt?.attemptCount === 1);

const usedRow = await markAuthCodeUsed(db, second.id, now);
check('markAuthCodeUsed sets used_at', usedRow?.usedAt !== null && usedRow?.usedAt !== undefined);

const afterUse = await getActiveAuthCode(db, now);
check('getActiveAuthCode returns null once the code is used', afterUse === null);

// Expiry: a code created already expired must not be "active".
const expired = await createAuthCode(db, 'hash-of-expired-code', new Date(now.getTime() - 1000));
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
check('getValidSessionByTokenHash returns null once past expires_at', expiredSessionCheck === null);

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

// --- cleanup ---

await client.execute({
	sql: 'delete from auth_codes where id in (?, ?, ?)',
	args: [first.id, second.id, expired.id]
});

await client.close();
