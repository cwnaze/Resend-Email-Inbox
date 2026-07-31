// Standalone smoke test for the outbound send path (US-H02): the minted
// `Message-ID`, and `storeSentEmail` against the live Turso DB.
//
// Run with:
//   node --env-file=.env node_modules/.bin/tsx src/lib/server/outbound/verify-outbound-send.mts
//
// Same shape as `src/lib/server/db/verify-inbox-list.mts`: the pure half runs on
// fixtures, the write half seeds into the live database (there is no separate
// test database), and the `finally` block deletes every row it created in
// emails → threads → contacts order because the remote connection enforces FKs.
//
// The Resend call itself is deliberately *not* exercised here — a verification
// script that sends real mail on every run is a script nobody runs. Delivery is
// proved in `docs/demos/US-H02.md` against the real API.
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { inArray, like } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { contacts, emails, threads } from '../db/schema.js';
import type { Database } from '../db/types.js';
import { getThreadById, listThreadEmails } from '../db/emails.js';
import { listInboxThreads } from '../db/inbox.js';
import { newOutboundMessageId, senderDomain } from './message-id.js';
import { storeSentEmail } from './store.js';

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
// Pure: the minted Message-ID
// ---------------------------------------------------------------------------

console.log('newOutboundMessageId / senderDomain');
equal('takes the domain of the sending address', senderDomain('casey@Example.COM'), 'example.com');
equal(
	'takes the last @ so a quoted local part cannot steal the domain',
	senderDomain('"weird@local"@example.com'),
	'example.com'
);
check(
	'rejects an address with no domain',
	(() => {
		try {
			senderDomain('nope');
			return false;
		} catch {
			return true;
		}
	})()
);

const minted = newOutboundMessageId('casey@caseynazelrod.com');
check(
	'is angle-bracketed <uuid@domain>, the form In-Reply-To arrives in',
	/^<[0-9a-f-]{36}@caseynazelrod\.com>$/.test(minted),
	minted
);
check('is unique per call', newOutboundMessageId('a@b.com') !== newOutboundMessageId('a@b.com'));

// ---------------------------------------------------------------------------
// storeSentEmail against the live DB
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

const stamp = `outbound-verify-${process.pid}`;
// A throwaway domain, never a real correspondent's — the `finally` deletes
// contacts by this suffix.
const recipientDomain = `${stamp}.example`;
const threadIds: string[] = [];
const emailIds: string[] = [];

const sender = 'casey@caseynazelrod.com';
const sentAt = new Date('2020-01-02T00:00:00.000Z');

try {
	console.log('storeSentEmail — live DB');

	const first = await storeSentEmail(
		db,
		{
			messageId: newOutboundMessageId(sender),
			inReplyTo: null,
			threadId: null,
			fromEmail: sender,
			toEmails: [`alice@${recipientDomain}`],
			ccEmails: [`bob@${recipientDomain}`],
			subject: `Re: ${stamp} hello there`,
			bodyText: 'first line\nsecond line'
		},
		sentAt
	);
	threadIds.push(first.email.threadId);
	emailIds.push(first.email.id);

	check('a message with no thread starts one', first.threadCreated);
	equal('the row is outbound', first.email.direction, 'outbound');
	check('the row is read — the owner wrote it', first.email.isRead);
	check('the row is not deleted', !first.email.isDeleted);
	equal('the recipients are stored as given', first.email.toEmails, [`alice@${recipientDomain}`]);
	equal('cc is stored', first.email.ccEmails, [`bob@${recipientDomain}`]);
	equal('bcc is an empty list, never null', first.email.bccEmails, []);
	equal('the body is stored as text', first.email.bodyText, 'first line\nsecond line');
	equal('no HTML part is invented', first.email.bodyHtml, null);
	equal('received_at is the send time (the inbox sort key)', +first.email.receivedAt, +sentAt);

	const firstThread = await getThreadById(db, first.email.threadId);
	equal(
		'the thread subject is normalized, so a reply to this message can match it',
		firstThread?.subject,
		`${stamp.toLowerCase()} hello there`
	);
	check('a thread of only sent mail is read', firstThread?.isRead === true);
	equal('the thread sorts at the send time', +(firstThread?.lastMessageAt ?? 0), +sentAt);

	const seededContacts = await db
		.select()
		.from(contacts)
		.where(like(contacts.email, `%@${recipientDomain}`));
	equal('a contact is upserted per recipient, To and Cc alike (FR-5)', seededContacts.length, 2);
	check(
		'they are auto-created and nameless — compose drops display names',
		seededContacts.every((row) => row.autoCreated && row.name === null)
	);

	// A second send into the *same* thread, the shape US-H03 will use.
	const second = await storeSentEmail(
		db,
		{
			messageId: newOutboundMessageId(sender),
			inReplyTo: first.email.messageId,
			threadId: first.email.threadId,
			fromEmail: sender,
			toEmails: [`alice@${recipientDomain}`],
			ccEmails: [],
			subject: `Re: ${stamp} hello there`,
			bodyText: 'a reply'
		},
		new Date(sentAt.getTime() + 60_000)
	);
	emailIds.push(second.email.id);

	check('an explicit thread id is joined, not duplicated', !second.threadCreated);
	equal('both messages are in one thread', second.email.threadId, first.email.threadId);
	equal('the parent Message-ID is recorded', second.email.inReplyTo, first.email.messageId);
	equal(
		'the thread now holds both messages, oldest first',
		(await listThreadEmails(db, first.email.threadId)).map((row) => row.bodyText),
		['first line\nsecond line', 'a reply']
	);
	equal(
		'last_message_at moved forward to the newer send',
		+((await getThreadById(db, first.email.threadId))?.lastMessageAt ?? 0),
		sentAt.getTime() + 60_000
	);

	// An older send must not drag the thread back down the inbox order.
	const backdated = await storeSentEmail(
		db,
		{
			messageId: newOutboundMessageId(sender),
			inReplyTo: null,
			threadId: first.email.threadId,
			fromEmail: sender,
			toEmails: [`alice@${recipientDomain}`],
			ccEmails: [],
			subject: `Re: ${stamp} hello there`,
			bodyText: 'backdated'
		},
		new Date(sentAt.getTime() - 3_600_000)
	);
	emailIds.push(backdated.email.id);
	equal(
		'last_message_at only ever moves forward',
		+((await getThreadById(db, first.email.threadId))?.lastMessageAt ?? 0),
		sentAt.getTime() + 60_000
	);

	// The is_read recompute: an unread *inbound* sibling has to survive a send
	// into the same thread. Replying is not reading.
	const [unread] = await db
		.insert(emails)
		.values([
			{
				threadId: first.email.threadId,
				messageId: `<${stamp}-unread@invalid>`,
				direction: 'inbound' as const,
				fromEmail: `alice@${recipientDomain}`,
				toEmails: [sender],
				subject: `Re: ${stamp} hello there`,
				bodyText: 'unread inbound',
				isRead: false,
				receivedAt: sentAt
			}
		])
		.returning();
	emailIds.push(unread.id);

	const afterUnread = await storeSentEmail(
		db,
		{
			messageId: newOutboundMessageId(sender),
			inReplyTo: null,
			threadId: first.email.threadId,
			fromEmail: sender,
			toEmails: [`alice@${recipientDomain}`],
			ccEmails: [],
			subject: `Re: ${stamp} hello there`,
			bodyText: 'sent while a sibling is unread'
		},
		new Date(sentAt.getTime() + 120_000)
	);
	emailIds.push(afterUnread.email.id);
	check(
		'sending into a thread with an unread message leaves it unread',
		(await getThreadById(db, first.email.threadId))?.isRead === false
	);

	// And the whole point of storing the row: it shows up in the inbox.
	const listed = (await listInboxThreads(db)).find((row) => row.threadId === first.email.threadId);
	check('the thread appears in the inbox list', listed !== undefined);
	equal('its preview is the newest message', listed?.bodyText, 'sent while a sibling is unread');
} finally {
	if (emailIds.length > 0) {
		await db.delete(emails).where(inArray(emails.id, emailIds));
	}
	if (threadIds.length > 0) {
		await db.delete(threads).where(inArray(threads.id, threadIds));
	}
	await db.delete(contacts).where(like(contacts.email, `%@${recipientDomain}`));
	client.close();
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
