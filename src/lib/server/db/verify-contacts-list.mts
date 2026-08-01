// Standalone smoke test for `/contacts`'s query helpers against the live Turso
// DB: `listContacts` (US-I01) and `updateContactName` (US-I02).
//
// Run with:
//   node --env-file=.env node_modules/.bin/tsx src/lib/server/db/verify-contacts-list.mts
//
// Same shape as `verify-inbox-list.mts`: there is no separate test database, so
// this seeds rows into the live one and the `finally` block deletes every
// seeded row in emails → threads → contacts order (the remote connection
// enforces the FKs). Every assertion filters down to the rows this run seeded,
// so real mail in the database can't change the result.
//
// What is actually worth verifying here is the SQL, not the shape: the
// correspondence rule spans `json_each` over two JSON columns, a `lower()`
// comparison on both sides, the soft-delete exclusion, and a LEFT JOIN whose
// no-match row has to count as 0. None of that is expressible as a type.
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { inArray } from 'drizzle-orm';
import * as schema from './schema.js';
import { contacts, emails, threads } from './schema.js';
import type { Database } from './types.js';
import { listContacts, updateContactName, upsertAutoContact } from './contacts.js';

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: unknown) {
	checks++;
	if (condition) {
		console.log(`  ok   ${label}`);
	} else {
		failures++;
		console.log(`  FAIL ${label}`, detail === undefined ? '' : detail);
	}
}

function equal(label: string, actual: unknown, expected: unknown) {
	const same = JSON.stringify(actual) === JSON.stringify(expected);
	check(label, same, same ? undefined : { actual, expected });
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

const client = createClient({
	url: requireEnv('TURSO_DATABASE_URL'),
	authToken: requireEnv('TURSO_AUTH_TOKEN')
});
const db = drizzle(client, { schema }) as unknown as Database;

const stamp = `contacts-verify-${process.pid}`;
const domain = `${stamp}.invalid`;
const threadIds: string[] = [];
const emailIds: string[] = [];
const contactIds: string[] = [];

/** A distinct base time well in the past so seeded rows can't outrank real mail. */
const base = new Date('2020-01-01T00:00:00.000Z').getTime();
const at = (offsetMinutes: number) => new Date(base + offsetMinutes * 60_000);

const sender = `zoe.sender@${domain}`;
const recipient = `alan.recipient@${domain}`;
const ccOnly = `mia.cc@${domain}`;
const bccOnly = `nils.bcc@${domain}`;
const silent = `quinn.silent@${domain}`;

try {
	console.log('listContacts — live DB');

	const seededContacts = await db
		.insert(contacts)
		.values([
			// Deliberately out of alphabetical order on insert, and with the
			// stored address in a different case than the `emails` rows use.
			{ email: sender, name: 'Zoe Sender', autoCreated: true },
			{ email: recipient, name: 'Alan Recipient', autoCreated: false },
			// No name: sorts (and renders) by address.
			{ email: ccOnly, name: null, autoCreated: true },
			{ email: bccOnly, name: 'Nils Bcc', autoCreated: true },
			{ email: silent, name: 'Quinn Silent', autoCreated: false }
		])
		.returning();
	contactIds.push(...seededContacts.map((row) => row.id));

	const [thread] = await db
		.insert(threads)
		.values([{ subject: `${stamp} thread`, lastMessageAt: at(30), isRead: true }])
		.returning();
	threadIds.push(thread.id);

	const seededEmails = await db
		.insert(emails)
		.values([
			// Inbound from the sender — matches on `from_email`, in a different
			// case than the contact row stores.
			{
				threadId: thread.id,
				messageId: `<${stamp}-in-1@invalid>`,
				direction: 'inbound' as const,
				fromEmail: sender.toUpperCase(),
				fromName: 'Zoe Sender',
				toEmails: ['owner@example.com'],
				subject: 'Inbound one',
				bodyText: 'one',
				receivedAt: at(10)
			},
			// A second inbound from the same sender, later — pins both the count
			// and which timestamp `max()` picks.
			{
				threadId: thread.id,
				messageId: `<${stamp}-in-2@invalid>`,
				direction: 'inbound' as const,
				fromEmail: sender,
				toEmails: ['owner@example.com'],
				subject: 'Inbound two',
				bodyText: 'two',
				receivedAt: at(30)
			},
			// Outbound addressed to one contact in `to` and another in `cc`.
			{
				threadId: thread.id,
				messageId: `<${stamp}-out-1@invalid>`,
				direction: 'outbound' as const,
				fromEmail: 'owner@example.com',
				toEmails: [recipient.toUpperCase()],
				ccEmails: [ccOnly],
				subject: 'Outbound one',
				bodyText: 'three',
				receivedAt: at(20)
			},
			// Soft-deleted: must not count for anyone on it.
			{
				threadId: thread.id,
				messageId: `<${stamp}-out-2@invalid>`,
				direction: 'outbound' as const,
				fromEmail: 'owner@example.com',
				toEmails: [recipient],
				subject: 'Outbound deleted',
				bodyText: 'four',
				isDeleted: true,
				receivedAt: at(40)
			},
			// Bcc-only: deliberately not counted as visible correspondence, and
			// its NULL `cc_emails` is what would make `json_each` throw without
			// the `coalesce`.
			{
				threadId: thread.id,
				messageId: `<${stamp}-out-3@invalid>`,
				direction: 'outbound' as const,
				fromEmail: 'owner@example.com',
				toEmails: ['owner@example.com'],
				bccEmails: [bccOnly],
				subject: 'Outbound bcc',
				bodyText: 'five',
				receivedAt: at(25)
			}
		])
		.returning();
	emailIds.push(...seededEmails.map((row) => row.id));

	const all = await listContacts(db);
	const seeded = all.filter((row) => contactIds.includes(row.id));
	const byEmail = new Map(seeded.map((row) => [row.email, row]));

	check('returns every contact, including ones with no mail', seeded.length === 5, seeded.length);

	equal(
		'sorts by display name falling back to the address',
		seeded.map((row) => row.name ?? row.email),
		['Alan Recipient', ccOnly, 'Nils Bcc', 'Quinn Silent', 'Zoe Sender']
	);

	equal('counts inbound mail by sender, case-insensitively', byEmail.get(sender)?.messageCount, 2);
	equal(
		'takes the latest received_at as last-contacted',
		byEmail.get(sender)?.lastContactedAt?.toISOString(),
		at(30).toISOString()
	);

	equal(
		'counts outbound mail by To recipient, case-insensitively',
		byEmail.get(recipient)?.messageCount,
		1
	);
	equal(
		'excludes a soft-deleted message from the count',
		byEmail.get(recipient)?.lastContactedAt?.toISOString(),
		at(20).toISOString()
	);

	equal('counts outbound mail by Cc recipient', byEmail.get(ccOnly)?.messageCount, 1);

	equal('does not count a Bcc-only recipient', byEmail.get(bccOnly)?.messageCount, 0);
	equal('leaves last-contacted null with no mail', byEmail.get(bccOnly)?.lastContactedAt, null);

	equal('a contact with no mail at all counts 0', byEmail.get(silent)?.messageCount, 0);
	check(
		'contacts with no mail still preserve auto_created',
		byEmail.get(silent)?.autoCreated === false && byEmail.get(sender)?.autoCreated === true
	);

	// --- updateContactName (US-I02) ---------------------------------------
	//
	// The point of the rename is not the `name` write, which a typecheck would
	// catch; it is that the write also clears `auto_created`, and that the flag
	// then actually stops `upsertAutoContact` from putting the old name back.
	// Only a real round trip through both helpers shows that, so this asserts on
	// the pair rather than on the update alone.
	console.log('updateContactName — live DB');

	const senderId = byEmail.get(sender)!.id;

	const renamed = await updateContactName(db, senderId, '  Zoe Q. Sender  ');
	equal('trims the stored name', renamed?.name, 'Zoe Q. Sender');
	check('clears auto_created on a manual rename', renamed?.autoCreated === false);

	// The exact regression FR-2 exists to prevent: the next delivery from this
	// address carries the sender's own inconsistent display name.
	const afterInbound = await upsertAutoContact(db, { email: sender, name: 'zoe (mobile)' });
	check('a later auto-upsert does not overwrite a manual name', !afterInbound.nameUpdated);
	equal('the manual name survives the auto-upsert', afterInbound.contact.name, 'Zoe Q. Sender');

	// Blank stores NULL, not '': the list's sort and `displayName` both treat
	// NULL as "fall back to the address", and '' would sort ahead of every name.
	const cleared = await updateContactName(db, senderId, '   ');
	equal('a blank name is stored as null', cleared?.name, null);
	const afterClear = await listContacts(db);
	equal(
		'a cleared name sorts and renders by address again',
		afterClear.find((row) => row.id === senderId)?.name,
		null
	);

	// An id that is gone is the caller's problem to report (the route 404s), not
	// a thrown error here.
	equal(
		'returns undefined for an unknown contact id',
		await updateContactName(db, `${stamp}-nonexistent`, 'Nobody'),
		undefined
	);
} finally {
	if (emailIds.length > 0) {
		await db.delete(emails).where(inArray(emails.id, emailIds));
	}
	if (threadIds.length > 0) {
		await db.delete(threads).where(inArray(threads.id, threadIds));
	}
	if (contactIds.length > 0) {
		await db.delete(contacts).where(inArray(contacts.id, contactIds));
	}
	client.close();
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
