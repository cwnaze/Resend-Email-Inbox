// Standalone smoke-test for the contact-form intake path.
//
// Runs against a throwaway local SQLite file, never the real Turso database — a
// verification run must not put test messages in the actual inbox. Same
// standalone-script pattern as `src/lib/server/db/verify-schema.mts`: no
// `$env/dynamic/private`, so it works outside a Vite runtime.
//
// Run via: node_modules/.bin/tsx src/lib/server/contact/verify-contact-submission.mts
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../db/schema';
import type { Database } from '../db/types';
import { CONTACT_MAILBOX, storeContactSubmission, validateSubmission } from './submission';

const dbPath = join(mkdtempSync(join(tmpdir(), 'contact-verify-')), 'test.db');
const client = createClient({ url: `file:${dbPath}` });

// Minimal DDL for the tables this path touches. Kept in sync with schema.ts by
// hand because the project pushes its schema with drizzle-kit rather than
// keeping migration files to replay here.
const ddl = [
	`create table contacts (
		id text primary key not null,
		email text not null,
		name text,
		auto_created integer default true not null,
		created_at integer default (unixepoch('subsec') * 1000) not null,
		updated_at integer default (unixepoch('subsec') * 1000) not null
	)`,
	`create unique index contacts_email_unique on contacts (email)`,
	`create table threads (
		id text primary key not null,
		subject text not null,
		last_message_at integer not null,
		is_read integer default false not null,
		created_at integer default (unixepoch('subsec') * 1000) not null
	)`,
	`create index threads_last_message_at_idx on threads (last_message_at)`,
	`create table emails (
		id text primary key not null,
		thread_id text not null references threads(id),
		message_id text not null,
		in_reply_to text,
		direction text not null,
		from_email text not null,
		from_name text,
		to_emails text not null,
		cc_emails text,
		bcc_emails text,
		subject text not null,
		body_text text,
		body_html text,
		is_read integer default false not null,
		is_deleted integer default false not null,
		received_at integer not null,
		created_at integer default (unixepoch('subsec') * 1000) not null
	)`,
	`create unique index emails_message_id_unique on emails (message_id)`,
	`create index emails_thread_id_idx on emails (thread_id)`
];
for (const statement of ddl) await client.execute(statement);

const db = drizzle(client, { schema }) as unknown as Database;

let failures = 0;
function check(label: string, passed: boolean, detail = '') {
	if (!passed) failures++;
	console.log(`${passed ? 'PASS' : 'FAIL'}: ${label}${detail ? ` — ${detail}` : ''}`);
}

// --- validation ---
check('rejects a non-object body', !validateSubmission('nope').ok);
check('rejects a missing name', !validateSubmission({ email: 'a@b.com', message: 'hi' }).ok);
check(
	'rejects a malformed address',
	!validateSubmission({ name: 'A', email: 'not-an-email', message: 'hi' }).ok
);
check(
	'rejects an oversized message',
	!validateSubmission({ name: 'A', email: 'a@b.com', message: 'x'.repeat(10_001) }).ok
);

const normalized = validateSubmission({
	name: '  Casey\r\nBcc: evil@example.com  ',
	email: '  Visitor@Example.COM ',
	message: '  line one\nline two  '
});
check(
	'strips control characters and normalizes the address',
	normalized.ok &&
		!/[\r\n]/.test(normalized.value.name) &&
		normalized.value.email === 'visitor@example.com' &&
		normalized.value.message === 'line one\nline two',
	normalized.ok ? JSON.stringify(normalized.value) : normalized.reason
);

// --- storage ---
const first = await storeContactSubmission(db, {
	name: 'Casey',
	email: 'visitor@example.com',
	message: 'First message'
});
check('stores a submission as an inbound email', first.created && first.threadMatch === 'new');
check(
	'stores the message as plain text with no html',
	first.email.bodyText === 'First message' && first.email.bodyHtml === null
);
check(
	'addresses the email to the mailbox and preserves the sender',
	first.email.fromEmail === 'visitor@example.com' &&
		first.email.fromName === 'Casey' &&
		JSON.stringify(first.email.toEmails) === JSON.stringify([CONTACT_MAILBOX])
);

const contactRows = await client.execute('select email, name from contacts');
check(
	'upserts the sender as a contact',
	contactRows.rows.length === 1 && contactRows.rows[0].email === 'visitor@example.com',
	JSON.stringify(contactRows.rows)
);

const second = await storeContactSubmission(db, {
	name: 'Casey',
	email: 'visitor@example.com',
	message: 'Second message'
});
check(
	'a repeat submission is a new email, threaded with the first',
	second.created &&
		second.email.id !== first.email.id &&
		second.email.threadId === first.email.threadId,
	`threadMatch=${second.threadMatch}`
);

const other = await storeContactSubmission(db, {
	name: 'Someone Else',
	email: 'other@example.com',
	message: 'Hello'
});
check('a different sender gets its own thread', other.email.threadId !== first.email.threadId);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
