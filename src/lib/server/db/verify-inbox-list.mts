// Standalone smoke test for the inbox list (US-F01): the pure presentation
// helpers in `$lib/inbox/format.ts`, and `listInboxThreads` against the live
// Turso DB.
//
// Run with:
//   node --env-file=.env node_modules/.bin/tsx src/lib/server/db/verify-inbox-list.mts
//
// Same shape as `src/lib/server/inbound/verify-inbound-parse.mts`: the pure half
// runs on fixtures, the query half seeds rows into the live database (there is
// no separate test database), and the `finally` block deletes every seeded row
// in attachments → emails → threads order because the remote connection
// enforces the FKs.
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq, inArray } from 'drizzle-orm';
import * as schema from './schema.js';
import { emails, threads } from './schema.js';
import type { Database } from './types.js';
import { getThreadById, markThreadRead } from './emails.js';
import { listInboxThreads } from './inbox.js';
import { bodySnippet, relativeTime, senderLabel } from '../../inbox/format.js';

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

// ---------------------------------------------------------------------------
// Pure: bodySnippet
// ---------------------------------------------------------------------------

console.log('bodySnippet');
equal('prefers the plain-text body', bodySnippet('Hello there', '<p>ignored</p>'), 'Hello there');
equal(
	'falls back to de-tagged HTML when there is no text body',
	bodySnippet(null, '<p>Hello <strong>there</strong></p>'),
	'Hello there'
);
equal(
	'treats a whitespace-only text body as absent',
	bodySnippet('   \n  ', '<p>From html</p>'),
	'From html'
);
equal('collapses runs of whitespace to single spaces', bodySnippet('a\n\n\tb   c', null), 'a b c');
equal('returns an empty string when there is nothing to preview', bodySnippet(null, null), '');
equal(
	'drops style/script content rather than previewing CSS',
	bodySnippet(null, '<style>p{color:red}</style><p>Body</p>'),
	'Body'
);
equal(
	'decodes the entities a reader would otherwise see literally',
	bodySnippet(null, '<p>Tom &amp; Jerry &lt;3 &nbsp;you</p>'),
	'Tom & Jerry <3 you'
);
equal(
	'inserts a gap where a block element ended',
	bodySnippet(null, '<p>one</p><p>two</p>'),
	'one two'
);
check(
	'truncates at the requested length with an ellipsis',
	bodySnippet('word '.repeat(50), null, 40).length <= 41 &&
		bodySnippet('word '.repeat(50), null, 40).endsWith('…')
);
check('does not truncate mid-word', !/wor…$/.test(bodySnippet('word '.repeat(50), null, 40)));
equal('leaves a body shorter than the limit untouched', bodySnippet('short', null, 40), 'short');

// ---------------------------------------------------------------------------
// Pure: senderLabel + relativeTime
// ---------------------------------------------------------------------------

console.log('senderLabel');
equal('prefers the display name', senderLabel('Ada Lovelace', 'ada@example.com'), 'Ada Lovelace');
equal('falls back to the address', senderLabel(null, 'ada@example.com'), 'ada@example.com');
equal('treats a blank name as absent', senderLabel('   ', 'ada@example.com'), 'ada@example.com');

console.log('relativeTime');
const now = new Date('2026-07-27T12:00:00.000Z');
equal(
	'under a minute reads as now',
	relativeTime(new Date('2026-07-27T11:59:30.000Z'), now),
	'now'
);
equal('minutes', relativeTime(new Date('2026-07-27T11:35:00.000Z'), now), '25m ago');
equal('hours', relativeTime(new Date('2026-07-27T10:00:00.000Z'), now), '2h ago');
equal('days', relativeTime(new Date('2026-07-24T12:00:00.000Z'), now), '3d ago');
check(
	'older than a week falls back to an absolute date',
	/^Jul \d+$/.test(relativeTime(new Date('2026-07-10T12:00:00.000Z'), now))
);
check(
	'a different year keeps the year',
	relativeTime(new Date('2025-03-02T12:00:00.000Z'), now).includes('2025')
);
equal(
	'a future timestamp (clock skew) reads as now, never a negative duration',
	relativeTime(new Date('2026-07-27T12:05:00.000Z'), now),
	'now'
);

// ---------------------------------------------------------------------------
// listInboxThreads against the live DB
// ---------------------------------------------------------------------------

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

const stamp = `inbox-list-verify-${process.pid}`;
const threadIds: string[] = [];
const emailIds: string[] = [];

/** A distinct base time well in the past so seeded rows can't outrank real mail. */
const base = new Date('2020-01-01T00:00:00.000Z').getTime();
const at = (offsetMinutes: number) => new Date(base + offsetMinutes * 60_000);

try {
	console.log('listInboxThreads — live DB');

	// Three threads: oldest activity, newest activity, and one whose only email
	// is soft-deleted. Plus a two-message thread to pin the "latest email wins"
	// preview and the message count.
	const [older, newer, deletedOnly, multi] = await db
		.insert(threads)
		.values([
			{ subject: `${stamp} older`, lastMessageAt: at(0), isRead: true },
			{ subject: `${stamp} newer`, lastMessageAt: at(20), isRead: false },
			{ subject: `${stamp} deleted-only`, lastMessageAt: at(10), isRead: true },
			{ subject: `${stamp} multi`, lastMessageAt: at(15), isRead: false }
		])
		.returning();
	threadIds.push(older.id, newer.id, deletedOnly.id, multi.id);

	const seededEmails = await db
		.insert(emails)
		.values([
			{
				threadId: older.id,
				messageId: `<${stamp}-older@invalid>`,
				direction: 'inbound' as const,
				fromEmail: 'older@example.com',
				fromName: 'Older Sender',
				toEmails: ['owner@example.com'],
				subject: 'Older subject',
				bodyText: 'Older body',
				isRead: true,
				receivedAt: at(0)
			},
			{
				threadId: newer.id,
				messageId: `<${stamp}-newer@invalid>`,
				direction: 'inbound' as const,
				fromEmail: 'newer@example.com',
				fromName: null,
				toEmails: ['owner@example.com'],
				subject: 'Newer subject',
				bodyText: null,
				bodyHtml: '<p>Newer <strong>body</strong></p>',
				receivedAt: at(20)
			},
			{
				threadId: deletedOnly.id,
				messageId: `<${stamp}-deleted@invalid>`,
				direction: 'inbound' as const,
				fromEmail: 'deleted@example.com',
				toEmails: ['owner@example.com'],
				subject: 'Deleted subject',
				bodyText: 'Deleted body',
				isDeleted: true,
				receivedAt: at(10)
			},
			// The older of the two, and soft-deleted, so it must not be the preview.
			{
				threadId: multi.id,
				messageId: `<${stamp}-multi-1@invalid>`,
				direction: 'inbound' as const,
				fromEmail: 'first@example.com',
				toEmails: ['owner@example.com'],
				subject: 'First in thread',
				bodyText: 'First body',
				receivedAt: at(11)
			},
			{
				threadId: multi.id,
				messageId: `<${stamp}-multi-2@invalid>`,
				direction: 'inbound' as const,
				fromEmail: 'second@example.com',
				fromName: 'Second Sender',
				toEmails: ['owner@example.com'],
				subject: 'Second in thread',
				bodyText: 'Second body',
				receivedAt: at(15)
			},
			{
				threadId: multi.id,
				messageId: `<${stamp}-multi-3@invalid>`,
				direction: 'inbound' as const,
				fromEmail: 'third@example.com',
				toEmails: ['owner@example.com'],
				subject: 'Third but deleted',
				bodyText: 'Third body',
				isDeleted: true,
				receivedAt: at(18)
			}
		])
		.returning();
	emailIds.push(...seededEmails.map((row) => row.id));

	const rows = await listInboxThreads(db, { limit: 200 });
	const seeded = rows.filter((row) => threadIds.includes(row.threadId));

	check('returns a row for each thread with a visible email', seeded.length === 3, seeded.length);
	check(
		'excludes a thread whose only email is soft-deleted',
		!seeded.some((row) => row.threadId === deletedOnly.id)
	);
	equal(
		'orders by last_message_at descending',
		seeded.map((row) => row.threadSubject),
		[`${stamp} newer`, `${stamp} multi`, `${stamp} older`]
	);

	const multiRow = seeded.find((row) => row.threadId === multi.id)!;
	equal(
		'previews the latest non-deleted email, not the newest deleted one',
		multiRow.subject,
		'Second in thread'
	);
	equal('carries that email’s sender', multiRow.fromEmail, 'second@example.com');
	equal('counts only non-deleted emails in the thread', multiRow.messageCount, 2);

	const newerRow = seeded.find((row) => row.threadId === newer.id)!;
	equal('counts a single-email thread as one', newerRow.messageCount, 1);
	equal('carries the thread read state', newerRow.isRead, false);
	equal('carries the read state of a read thread', seeded.at(-1)!.isRead, true);
	check('exposes lastMessageAt as a Date', newerRow.lastMessageAt instanceof Date);
	equal(
		'an HTML-only body still yields a snippet',
		bodySnippet(newerRow.bodyText, newerRow.bodyHtml),
		'Newer body'
	);
	equal(
		'a nameless sender falls back to the address for display',
		senderLabel(newerRow.fromName, newerRow.fromEmail),
		'newer@example.com'
	);

	const limited = await listInboxThreads(db, { limit: 1 });
	check('honors the limit', limited.length === 1, limited.length);

	// -------------------------------------------------------------------------
	// markThreadRead (US-F02)
	// -------------------------------------------------------------------------

	console.log('markThreadRead — live DB');

	await markThreadRead(db, multi.id);

	const multiEmails = await db.select().from(emails).where(eq(emails.threadId, multi.id));
	check(
		'marks every email in the thread read, soft-deleted ones included',
		multiEmails.length === 3 && multiEmails.every((row) => row.isRead),
		multiEmails.map((row) => [row.subject, row.isRead])
	);
	equal('recomputes the thread flag to read', (await getThreadById(db, multi.id))!.isRead, true);

	// An unread email that is soft-deleted must not pin the thread unread: it is
	// not a visible message, so there'd be nothing on screen to explain the dot.
	const [hiddenUnread] = await db
		.insert(emails)
		.values([
			{
				threadId: multi.id,
				messageId: `<${stamp}-multi-4@invalid>`,
				direction: 'inbound' as const,
				fromEmail: 'fourth@example.com',
				toEmails: ['owner@example.com'],
				subject: 'Deleted and unread',
				isDeleted: true,
				isRead: false,
				receivedAt: at(19)
			}
		])
		.returning();
	emailIds.push(hiddenUnread.id);
	await markThreadRead(db, multi.id);
	equal(
		'a soft-deleted unread email does not keep the thread unread',
		(await getThreadById(db, multi.id))!.isRead,
		true
	);

	// The recompute is what protects against a message arriving mid-open.
	const [arrived] = await db
		.insert(emails)
		.values([
			{
				threadId: older.id,
				messageId: `<${stamp}-older-2@invalid>`,
				direction: 'inbound' as const,
				fromEmail: 'later@example.com',
				toEmails: ['owner@example.com'],
				subject: 'Arrived later',
				isRead: false,
				receivedAt: at(30)
			}
		])
		.returning();
	emailIds.push(arrived.id);
	await db.update(threads).set({ isRead: false }).where(eq(threads.id, older.id));
	await markThreadRead(db, older.id);
	equal(
		'marking read clears a thread whose newly arrived message is now read too',
		(await getThreadById(db, older.id))!.isRead,
		true
	);

	// Unknown thread id: a no-op, not a throw (a deleted thread must not 500).
	await markThreadRead(db, `${stamp}-missing`);
	check('is a no-op for an unknown thread id', true);
	equal(
		'getThreadById misses on an unknown id',
		await getThreadById(db, `${stamp}-missing`),
		undefined
	);
} finally {
	if (emailIds.length > 0) {
		await db.delete(emails).where(inArray(emails.id, emailIds));
	}
	if (threadIds.length > 0) {
		await db.delete(threads).where(inArray(threads.id, threadIds));
	}
	client.close();
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
