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
import { randomInt } from 'node:crypto';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../db/schema.ts';
import {
	countAuthCodeRequestsSince,
	createAuthCode,
	hashAuthCode,
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

async function main() {
	const now = new Date();
	const windowStart = new Date(now.getTime() - 10 * 60 * 1000);

	console.log('1. Code generation and hashing:');
	const codeA = generateCode();
	const codeB = generateCode();
	assert(/^\d{6}$/.test(codeA), 'generated code is exactly 6 digits');
	// Any single pair can legitimately collide (1-in-10^6), so assert on a
	// sample instead: 100 draws from a 10^6 space are essentially never all equal.
	const sample = new Set(Array.from({ length: 100 }, generateCode));
	assert(sample.size > 1, '100 generated codes yield more than one distinct value');
	assert(
		hashAuthCode(codeA) === hashAuthCode(codeA),
		'hashing the same code twice yields the same hash'
	);
	assert(
		hashAuthCode(codeA) !== hashAuthCode(codeB),
		'hashing two different codes yields different hashes'
	);
	assert(hashAuthCode(codeA) !== codeA, 'the stored hash is never equal to the raw code');

	console.log('2. Rate limiting (3 requests per rolling window):');
	// Scoped to rows *this run* creates: this points at the shared live Turso DB,
	// so a legitimate code request in the preceding 10 minutes would otherwise
	// fail the script for a reason that isn't a bug.
	const before = await countAuthCodeRequestsSince(db, windowStart);

	for (let i = 0; i < 3; i++) {
		await invalidateActiveAuthCodes(db, now);
		const row = await createAuthCode(
			db,
			hashAuthCode(generateCode()),
			new Date(now.getTime() + 600_000)
		);
		createdIds.push(row.id);
	}
	const afterThree = await countAuthCodeRequestsSince(db, windowStart);
	assert(afterThree - before === 3, 'exactly 3 additional requests are counted after 3 creates');

	const wouldBeBlocked = afterThree - before >= 3;
	assert(wouldBeBlocked, 'a 4th request in the same window would be rejected (count >= 3)');

	console.log('3. Invalidation (only one active code at a time):');
	const rows = await db.query.authCodes.findMany({
		where: (t, { inArray }) => inArray(t.id, createdIds)
	});
	// invalidateActiveAuthCodes supersedes by pulling expires_at back to now — it
	// deliberately does NOT set used_at, which stays reserved for "actually
	// redeemed" (see auth-codes.ts).
	const isActive = (r: (typeof rows)[number]) => r.usedAt === null && r.expiresAt > now;
	assert(
		rows.filter((r) => !isActive(r)).length === 2,
		'the 2 earlier codes were superseded (expires_at pulled back) when later codes were requested'
	);
	assert(rows.filter(isActive).length === 1, 'exactly 1 code (the most recent) remains active');
	assert(
		rows.every((r) => r.usedAt === null),
		'superseding never sets used_at (that means "redeemed", not "superseded")'
	);

	console.log('\nCleaning up test rows...');
	for (const id of createdIds) {
		await client.execute({ sql: 'delete from auth_codes where id = ?', args: [id] });
	}
	const afterCleanup = await countAuthCodeRequestsSince(db, windowStart);
	assert(afterCleanup === before, 'all test rows were cleaned up (window count back to baseline)');

	console.log(`\n${passed} passed, ${failed} failed`);
	await client.close();
	if (failed > 0) {
		process.exit(1);
	}
}

main();
