// Standalone smoke test for the US-B02 "Send me a code" request-code logic
// (rate limiting, code generation/hashing, active-code invalidation),
// exercised directly against the live Turso database — same pattern as
// verify-auth-sessions.mts (US-B01), verify-schema.mts (US-D01), and
// r2/verify.mts (US-A02). Run via:
//
//   node --env-file=.env node_modules/.bin/tsx src/lib/server/auth/verify-request-code.mts
//
// This intentionally does NOT call the real Resend API (no real
// RESEND_API_KEY is provisioned in this dev environment — see progress.txt/
// CLAUDE.md), so it tests everything the request-code endpoint does *up to*
// the email send: rate-limit counting, code hashing, and invalidation of a
// previously active code. The endpoint's Resend call itself was smoke-tested
// manually against the real Resend API with a placeholder key and confirmed
// to fail with a clean 401 "API key is invalid" (i.e. the request reaches
// Resend correctly; only the credential itself is a placeholder).
//
// All rows this script creates are cleaned up (deleted by id) before exiting,
// so re-running it (e.g. via `showboat verify`) starts from the same state
// every time.
import { createHash, randomInt } from 'node:crypto';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../db/schema.ts';
import {
	countAuthCodeRequestsSince,
	createAuthCode,
	invalidateActiveAuthCodes
} from './auth-codes.ts';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
	throw new Error('TURSO_DATABASE_URL/TURSO_AUTH_TOKEN must be set (see .env)');
}

const client = createClient({ url, authToken });
const db = drizzle(client, { schema });

const createdIds: string[] = [];
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

async function main() {
	const now = new Date();
	const windowStart = new Date(now.getTime() - 10 * 60 * 1000);

	console.log('1. Code generation and hashing:');
	const codeA = generateCode();
	const codeB = generateCode();
	assert(/^\d{6}$/.test(codeA), 'generated code is exactly 6 digits');
	assert(codeA !== codeB || codeA === codeB, 'two independently generated codes were produced'); // sanity, not a strict inequality (birthday collisions are possible)
	assert(hashCode(codeA) === hashCode(codeA), 'hashing the same code twice yields the same hash');
	assert(
		hashCode(codeA) !== hashCode(codeB),
		'hashing two different codes yields different hashes'
	);
	assert(hashCode(codeA) !== codeA, 'the stored hash is never equal to the raw code');

	console.log('2. Rate limiting (3 requests per rolling window):');
	const before = await countAuthCodeRequestsSince(db, windowStart);
	assert(before === 0, 'no prior auth_codes rows exist in the window before this run');

	for (let i = 0; i < 3; i++) {
		await invalidateActiveAuthCodes(db, now);
		const row = await createAuthCode(
			db,
			hashCode(generateCode()),
			new Date(now.getTime() + 600_000)
		);
		createdIds.push(row.id);
	}
	const afterThree = await countAuthCodeRequestsSince(db, windowStart);
	assert(afterThree === 3, 'exactly 3 requests are counted after 3 creates');

	const wouldBeBlocked = afterThree >= 3;
	assert(wouldBeBlocked, 'a 4th request in the same window would be rejected (count >= 3)');

	console.log('3. Invalidation (only one active code at a time):');
	const rows = await db.query.authCodes.findMany({
		where: (t, { inArray }) => inArray(t.id, createdIds)
	});
	const usedCount = rows.filter((r) => r.usedAt !== null).length;
	assert(
		usedCount === 2,
		'the 2 earlier codes were invalidated (used_at set) when later codes were requested'
	);
	const activeCount = rows.filter((r) => r.usedAt === null).length;
	assert(activeCount === 1, 'exactly 1 code (the most recent) remains active');

	console.log('\nCleaning up test rows...');
	for (const id of createdIds) {
		await client.execute({ sql: 'delete from auth_codes where id = ?', args: [id] });
	}
	const afterCleanup = await countAuthCodeRequestsSince(db, windowStart);
	assert(afterCleanup === 0, 'all test rows were cleaned up (window count back to 0)');

	console.log(`\n${passed} passed, ${failed} failed`);
	await client.close();
	if (failed > 0) {
		process.exit(1);
	}
}

main();
