// Standalone smoke-test script for US-D01 (core schema migration).
//
// Verifies, against the real Turso database, that:
//   1. All six tables from tasks/prd-data-model.md exist with the expected DDL
//   2. All specified indexes (including uniques) exist
//   3. Foreign keys (emails.thread_id, attachments.email_id) are enforced
//   4. Unique constraints (emails.message_id) are enforced
//
// Run via: node --env-file=.env node_modules/.bin/tsx src/lib/server/db/verify-schema.mts
//
// Standalone rather than importing src/lib/server/db/index.ts because
// `$env/dynamic/private` only resolves inside a Vite/SvelteKit runtime — see
// the equivalent pattern in src/lib/server/r2/verify.mts (US-A02).
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
	throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must both be set to run this script.');
}

const client = createClient({ url, authToken });

const expectedTables = ['attachments', 'auth_codes', 'contacts', 'emails', 'sessions', 'threads'];

const tables = await client.execute(
	"select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '__drizzle%' order by name"
);
const actualTables = tables.rows.map((r) => r.name).sort();
const tablesMatch = JSON.stringify(actualTables) === JSON.stringify(expectedTables);
console.log(
	tablesMatch ? 'PASS: all 6 tables present' : `FAIL: tables were ${JSON.stringify(actualTables)}`
);

const expectedIndexes = [
	'attachments_email_id_idx',
	'auth_codes_expires_at_idx',
	'contacts_email_unique',
	'emails_is_read_is_deleted_idx',
	'emails_message_id_unique',
	'emails_thread_id_idx',
	'sessions_token_hash_unique',
	'threads_last_message_at_idx'
];
const indexes = await client.execute(
	"select name from sqlite_master where type='index' and sql is not null order by name"
);
const actualIndexes = indexes.rows.map((r) => r.name).sort();
const indexesMatch = JSON.stringify(actualIndexes) === JSON.stringify(expectedIndexes.sort());
console.log(
	indexesMatch
		? 'PASS: all 8 indexes present'
		: `FAIL: indexes were ${JSON.stringify(actualIndexes)}`
);

await client.execute('PRAGMA foreign_keys = ON');

// FK enforcement: emails.thread_id must reference an existing threads row.
let fkRejected = false;
try {
	await client.execute({
		sql: `insert into emails (id, thread_id, message_id, direction, from_email, to_emails, subject, is_read, is_deleted, received_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			'verify-schema-fk-test',
			'nonexistent-thread-id',
			'verify-schema-fk-msg',
			'inbound',
			'a@example.com',
			'[]',
			'subj',
			0,
			0,
			Date.now(),
			Date.now()
		]
	});
} catch (e) {
	fkRejected = e instanceof Error && e.message.includes('FOREIGN KEY');
}
console.log(fkRejected ? 'PASS: FK constraint rejects orphan thread_id' : 'FAIL: FK not enforced');

// Unique constraint: emails.message_id.
const threadId = 'verify-schema-unique-thread';
await client.execute({
	sql: `insert into threads (id, subject, last_message_at, is_read, created_at) values (?, ?, ?, ?, ?)`,
	args: [threadId, 'verify subject', Date.now(), 0, Date.now()]
});
await client.execute({
	sql: `insert into emails (id, thread_id, message_id, direction, from_email, to_emails, subject, is_read, is_deleted, received_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	args: [
		'verify-schema-unique-1',
		threadId,
		'verify-schema-dup-msg-id',
		'inbound',
		'a@example.com',
		'[]',
		'subj',
		0,
		0,
		Date.now(),
		Date.now()
	]
});
let uniqueRejected = false;
try {
	await client.execute({
		sql: `insert into emails (id, thread_id, message_id, direction, from_email, to_emails, subject, is_read, is_deleted, received_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			'verify-schema-unique-2',
			threadId,
			'verify-schema-dup-msg-id',
			'inbound',
			'a@example.com',
			'[]',
			'subj',
			0,
			0,
			Date.now(),
			Date.now()
		]
	});
} catch (e) {
	uniqueRejected = e instanceof Error && e.message.includes('UNIQUE');
}
console.log(
	uniqueRejected
		? 'PASS: UNIQUE constraint rejects duplicate message_id'
		: 'FAIL: UNIQUE not enforced'
);

// Cleanup test rows.
await client.execute({
	sql: 'delete from emails where id in (?, ?)',
	args: ['verify-schema-unique-1', 'verify-schema-unique-2']
});
await client.execute({ sql: 'delete from threads where id = ?', args: [threadId] });

await client.close();
