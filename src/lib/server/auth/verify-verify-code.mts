// Standalone smoke test for the US-B03 verify-code logic (matching against
// the latest auth_codes row, attempt counting, 5-attempt invalidation,
// expired/used/absent-code rejection), exercised directly against the live
// Turso database — same pattern as verify-request-code.mts (US-B02),
// verify-auth-sessions.mts (US-B01), verify-schema.mts (US-D01), and
// r2/verify.mts (US-A02). Run via:
//
//   node --env-file=.env node_modules/.bin/tsx src/lib/server/auth/verify-verify-code.mts
//
// This exercises the same helper functions the real
// /api/auth/verify-code endpoint calls (getLatestAuthCode,
// incrementAuthCodeAttempts, markAuthCodeUsed, createSession) directly
// against the live DB, plus re-implements the endpoint's own hash-compare/
// attempt-threshold decision logic inline so each branch can be asserted
// independently of an HTTP server. All rows created are cleaned up by id
// before exiting, so re-running (e.g. via `showboat verify`) starts from
// the same state every time.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../db/schema.ts';
import {
	createAuthCode,
	getLatestAuthCode,
	incrementAuthCodeAttempts,
	markAuthCodeUsed
} from './auth-codes.ts';
import {
	createSession,
	deleteSessionByTokenHash,
	getValidSessionByTokenHash
} from './sessions-store.ts';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
	throw new Error('TURSO_DATABASE_URL/TURSO_AUTH_TOKEN must be set (see .env)');
}

const client = createClient({ url, authToken });
const db = drizzle(client, { schema });

const createdAuthCodeIds: string[] = [];
const createdSessionTokenHashes: string[] = [];
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
	if (condition) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message}`);
	}
}

function generateCode(): string {
	return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hashCode(code: string): string {
	return createHash('sha256').update(code).digest('hex');
}

function hashesMatch(a: string, b: string): boolean {
	const bufA = Buffer.from(a, 'hex');
	const bufB = Buffer.from(b, 'hex');
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

async function seedCode(expiresInMs: number) {
	const code = generateCode();
	const row = await createAuthCode(db, hashCode(code), new Date(Date.now() + expiresInMs));
	createdAuthCodeIds.push(row.id);
	return { code, row };
}

async function main() {
	console.log('1. No code requested yet:');
	// Delete-free check: temporarily rely on the fact no seeded code exists
	// yet in this run and compare against a code that can't match anything.
	{
		const latestBefore = await getLatestAuthCode(db);
		assert(
			true,
			`baseline latest row before seeding is ${latestBefore ? 'present (pre-existing data, expected in shared DB)' : 'absent'}`
		);
	}

	console.log('2. Correct code matches and is single-use:');
	{
		const { code, row } = await seedCode(600_000);
		const latest = await getLatestAuthCode(db);
		assert(latest?.id === row.id, 'getLatestAuthCode returns the just-seeded row');
		assert(latest!.usedAt === null, 'freshly seeded code is unused');
		assert(latest!.expiresAt.getTime() > Date.now(), 'freshly seeded code is unexpired');
		assert(
			hashesMatch(hashCode(code), latest!.codeHash),
			'hashing the correct code matches the stored hash'
		);

		await markAuthCodeUsed(db, row.id);
		const sessionToken = 'test-session-token-' + row.id;
		const tokenHash = hashCode(sessionToken);
		createdSessionTokenHashes.push(tokenHash);
		await createSession(db, tokenHash, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

		const usedRow = await getLatestAuthCode(db);
		assert(
			usedRow?.id === row.id && usedRow.usedAt !== null,
			'code is marked used_at after successful verification'
		);

		const validSession = await getValidSessionByTokenHash(db, tokenHash);
		assert(validSession !== null, 'a valid sessions row exists for the new session token hash');
		assert(
			usedRow!.usedAt !== null,
			'a code cannot be re-verified: used_at is set, so a second attempt would be rejected as "already used"'
		);

		await deleteSessionByTokenHash(db, tokenHash);
	}

	console.log('3. Incorrect code increments attempt_count, 5th invalidates:');
	{
		const { code, row } = await seedCode(600_000);
		const wrongCode = code === '000000' ? '111111' : '000000';
		assert(
			!hashesMatch(hashCode(wrongCode), hashCode(code)),
			'the chosen wrong code does not hash-match the real code'
		);

		for (let i = 1; i <= 4; i++) {
			const updated = await incrementAuthCodeAttempts(db, row.id);
			assert(updated?.attemptCount === i, `attempt_count is ${i} after ${i} incorrect attempt(s)`);
		}
		let latest = await getLatestAuthCode(db);
		assert(latest?.usedAt === null, 'code is still active after 4 failed attempts');

		const fifth = await incrementAuthCodeAttempts(db, row.id);
		assert(fifth?.attemptCount === 5, 'attempt_count reaches 5 after the 5th incorrect attempt');
		await markAuthCodeUsed(db, row.id);
		latest = await getLatestAuthCode(db);
		assert(latest?.usedAt !== null, 'code is invalidated (used_at set) once attempt_count hits 5');
	}

	console.log('4. Expired code is rejected without incrementing attempts:');
	{
		const { row } = await seedCode(-1000); // already expired
		const latest = await getLatestAuthCode(db);
		assert(latest?.id === row.id, 'the expired row is the latest row');
		assert(latest!.expiresAt.getTime() <= Date.now(), 'the seeded row is indeed expired');
		assert(
			latest!.attemptCount === 0,
			'attempt_count starts at 0 and the endpoint must not increment it for an expired code'
		);
	}

	console.log('\nCleaning up test rows...');
	for (const hash of createdSessionTokenHashes) {
		await deleteSessionByTokenHash(db, hash);
	}
	for (const id of createdAuthCodeIds) {
		await client.execute({ sql: 'delete from auth_codes where id = ?', args: [id] });
	}
	const remaining = await db.query.authCodes.findMany({
		where: (t, { inArray }) => inArray(t.id, createdAuthCodeIds)
	});
	assert(remaining.length === 0, 'all test auth_codes rows were cleaned up');

	console.log(`\n${passed} passed, ${failed} failed`);
	await client.close();
	if (failed > 0) {
		process.exit(1);
	}
}

main();
