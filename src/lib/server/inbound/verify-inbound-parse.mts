// Standalone smoke test for inbound ingestion: payload parsing + contact upsert
// (US-E02), HTML sanitization + idempotent storage (US-E03), thread assignment
// (US-E04).
//
// Run with:
//   node --env-file=.env node_modules/.bin/tsx src/lib/server/inbound/verify-inbound-parse.mts
//
// Two halves:
//  - Parsing is pure, so it runs against fixtures. The `realDelivery` fixture is
//    a **real** `email.received` record fetched from this project's Resend
//    account (addresses/ids redacted, header quirks preserved verbatim) — that's
//    what makes the JSON-quoted `date` header and the quoted `From:` display
//    name assertions ground truth rather than guesses.
//  - The contact upsert runs against the live Turso DB (there is no separate
//    test database), building its own client from `process.env` since
//    `$env/dynamic/private` can't be imported outside Vite. Every inserted row
//    is deleted in the `finally` block.
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { inArray } from 'drizzle-orm';
import type { GetReceivingEmailResponseSuccess } from 'resend';
import * as schema from '../db/schema.js';
import { contacts } from '../db/schema.js';
import type { Database } from '../db/types.js';
import { getContactByEmail, normalizeEmail, upsertContactFromInbound } from '../db/contacts.js';
import { parseInboundWebhookEvent, parseReceivedEmail } from './parse.js';
import { sanitizeEmailHtml } from './sanitize.js';
import { storeInboundEmail } from './store.js';
import { normalizeSubject } from './threading.js';
import { emails, threads } from '../db/schema.js';

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
// Fixtures
// ---------------------------------------------------------------------------

/** Shape of a real `email.received` webhook body (metadata only). */
const webhookEvent = {
	type: 'email.received',
	created_at: '2026-07-25T15:15:33.224Z',
	data: {
		email_id: 'e625792c-0000-0000-0000-000000000000',
		created_at: '2026-07-25T15:15:33.224Z',
		from: 'sender@example.com',
		to: ['owner@example.com'],
		bcc: [],
		cc: [],
		received_for: ['owner@example.com'],
		message_id: '<abc-123@example.com>',
		subject: 'Verify your email address',
		attachments: []
	}
};

/** A real fetched record, redacted. Header quirks are verbatim. */
const realDelivery: GetReceivingEmailResponseSuccess = {
	object: 'email',
	id: 'e625792c-0000-0000-0000-000000000000',
	to: ['owner@example.com'],
	from: 'Sender@Example.com',
	created_at: '2026-07-25T15:15:33.224Z',
	subject: 'Verify your email address',
	bcc: [],
	cc: [],
	reply_to: [],
	received_for: ['owner@example.com'],
	html: '<!DOCTYPE html><html><body>hi</body></html>',
	text: 'hi',
	headers: {
		// Observed verbatim: Resend JSON-encodes some header values.
		date: '"2026-07-25T15:15:31.000Z"',
		from: '"Example Sender" <sender@example.com>',
		to: 'owner@example.com',
		'message-id': '<abc-123@example.com>',
		'mime-version': '1.0',
		'content-type': 'multipart/alternative'
	},
	message_id: '<abc-123@example.com>',
	attachments: []
};

const replyDelivery: GetReceivingEmailResponseSuccess = {
	...realDelivery,
	from: 'bare@example.com',
	cc: [' Cc.Person@Example.com ', ''],
	headers: {
		from: 'bare@example.com', // no display name
		'in-reply-to': '<parent-1@example.com>',
		references: '<root-0@example.com>  <parent-1@example.com>',
		date: 'not a date'
	},
	html: null,
	text: null
};

// ---------------------------------------------------------------------------
// Part 1 — envelope parsing (pure)
// ---------------------------------------------------------------------------

console.log('\nparseInboundWebhookEvent');
{
	const ok = parseInboundWebhookEvent(webhookEvent);
	check('accepts a real email.received envelope', ok.ok);
	equal('extracts email_id', ok.ok && ok.emailId, webhookEvent.data.email_id);

	const wrongType = parseInboundWebhookEvent({ type: 'email.delivered', data: {} });
	check('rejects a non-received event type', !wrongType.ok);

	check('rejects a non-object payload', !parseInboundWebhookEvent('nope').ok);
	check('rejects a null payload', !parseInboundWebhookEvent(null).ok);
	check('rejects a missing data object', !parseInboundWebhookEvent({ type: 'email.received' }).ok);
	check(
		'rejects a missing email_id',
		!parseInboundWebhookEvent({ type: 'email.received', data: { from: 'a@b.c' } }).ok
	);
	check(
		'rejects an empty email_id',
		!parseInboundWebhookEvent({ type: 'email.received', data: { email_id: '' } }).ok
	);
}

// ---------------------------------------------------------------------------
// Part 2 — received-email parsing (pure)
// ---------------------------------------------------------------------------

console.log('\nparseReceivedEmail — real delivery');
{
	const p = parseReceivedEmail(realDelivery);
	equal('message_id', p.messageId, '<abc-123@example.com>');

	// Message-ID is optional in RFC 5322 and unvalidated by Resend, but it is the
	// app's idempotence key — an empty one would make every subsequent such email
	// look like a duplicate of the first and be dropped with a 200.
	for (const [label, value] of [
		['absent', undefined],
		['null', null],
		['empty', ''],
		['whitespace-only', '   ']
	] as const) {
		const fallback = parseReceivedEmail({
			...realDelivery,
			message_id: value
		} as unknown as GetReceivingEmailResponseSuccess);
		equal(
			`a ${label} message_id falls back to the Resend email id`,
			fallback.messageId,
			`<resend-${realDelivery.id}@inbound.invalid>`
		);
	}
	equal('from address is lowercased from Resend`s own field', p.fromEmail, 'sender@example.com');
	equal('display name unquoted from the From: header', p.fromName, 'Example Sender');
	equal('to', p.toEmails, ['owner@example.com']);
	equal('cc defaults to empty', p.ccEmails, []);
	equal('subject', p.subject, 'Verify your email address');
	equal('bodyHtml passed through unsanitized (US-E03 sanitizes)', p.bodyHtml, realDelivery.html);
	equal('bodyText', p.bodyText, 'hi');
	equal('no In-Reply-To', p.inReplyTo, null);
	equal('no References', p.references, []);
	equal(
		'receivedAt comes from the JSON-quoted Date: header',
		p.receivedAt.toISOString(),
		'2026-07-25T15:15:31.000Z'
	);
	equal('attachments', p.attachments, []);
}

console.log('\nparseReceivedEmail — reply with no display name');
{
	const p = parseReceivedEmail(replyDelivery);
	equal('bare From: yields a null display name', p.fromName, null);
	equal('In-Reply-To', p.inReplyTo, '<parent-1@example.com>');
	equal('References split on whitespace', p.references, [
		'<root-0@example.com>',
		'<parent-1@example.com>'
	]);
	equal('cc trimmed, empties dropped', p.ccEmails, ['Cc.Person@Example.com']);
}

// Resend array-encodes a header that occurred more than once — observed on
// `received`. If `References` ever arrives that way, whitespace-splitting the
// raw string would yield JSON punctuation and poison US-E04 threading.
console.log('\nparseReceivedEmail — JSON array-encoded headers');
{
	const p = parseReceivedEmail({
		...replyDelivery,
		headers: {
			...replyDelivery.headers,
			references: JSON.stringify(['<root-0@example.com> <parent-1@example.com>']),
			'in-reply-to': JSON.stringify(['<parent-1@example.com>'])
		}
	} as GetReceivingEmailResponseSuccess);
	equal('array-encoded References decoded, not split as JSON text', p.references, [
		'<root-0@example.com>',
		'<parent-1@example.com>'
	]);
	equal('array-encoded In-Reply-To takes the first value', p.inReplyTo, '<parent-1@example.com>');
}

console.log('\nparseReceivedEmail — reply, remaining fields');
{
	const p = parseReceivedEmail(replyDelivery);
	equal('null html stays null', p.bodyHtml, null);
	equal(
		'unparseable Date: falls back to created_at',
		p.receivedAt.toISOString(),
		'2026-07-25T15:15:33.224Z'
	);
}

console.log('\nnormalizeSubject (US-E04)');
{
	equal('plain subject lowercased', normalizeSubject('Quarterly Report'), 'quarterly report');
	equal('Re: stripped', normalizeSubject('Re: Quarterly Report'), 'quarterly report');
	equal('stacked prefixes stripped', normalizeSubject('Re: Fwd: RE: Report'), 'report');
	equal('counted prefix stripped', normalizeSubject('Re[2]: Report'), 'report');
	equal(
		'whitespace collapsed',
		normalizeSubject('  RE:   Quarterly   Report '),
		'quarterly report'
	);
	equal('empty subject stays empty', normalizeSubject('   '), '');
	equal('a colon inside the subject survives', normalizeSubject('Status: green'), 'status: green');
}

// ---------------------------------------------------------------------------
// Part 3 — HTML sanitization (pure, US-E03)
// ---------------------------------------------------------------------------

console.log('\nsanitizeEmailHtml');
{
	const clean = sanitizeEmailHtml(
		[
			'<p>Hello <b>there</b></p>',
			'<script>alert(1)</script>',
			'<img src="https://cdn.example.com/pixel.gif" onerror="steal()" srcset="x 2x">',
			'<iframe src="https://evil.example.com"></iframe>',
			'<a href="javascript:alert(1)" onclick="x()">click</a>',
			'<a href="https://example.com/ok">ok</a>',
			'<link rel="stylesheet" href="https://evil.example.com/a.css">',
			'<style>body{background:url(https://evil.example.com/t.png)}</style>',
			'<div style="background:url(https://evil.example.com/t.png)" data-track="1">x</div>',
			'<form action="https://evil.example.com"><input name="pw"></form>'
		].join('')
	);
	const has = (needle: string) => (clean ?? '').includes(needle);

	check('keeps benign markup', has('<p>Hello <b>there</b></p>'));
	check('keeps a safe link', has('href="https://example.com/ok"'));
	check('strips <script>', !has('script') && !has('alert(1)'));
	check('strips event handlers', !has('onerror') && !has('onclick'));
	check('strips javascript: URLs', !has('javascript:'));
	check('strips <iframe>', !has('iframe'));
	check('strips <link>', !has('<link'));
	check('strips <style> and its contents', !has('<style') && !has('background:url'));
	check('strips srcset / style / data-* attributes', !has('srcset') && !has('data-track'));
	check('strips <form>/<input>', !has('<form') && !has('<input'));
	check('leaves no reference to the evil host', !has('evil.example.com'), clean);

	equal('null in, null out', sanitizeEmailHtml(null), null);
	equal('undefined in, null out', sanitizeEmailHtml(undefined), null);
	equal('blank in, null out', sanitizeEmailHtml('   \n'), null);
	equal('all-malicious body collapses to null', sanitizeEmailHtml('<script>x()</script>'), null);
}

// ---------------------------------------------------------------------------
// Part 4 — contact upsert + email storage (live Turso)
// ---------------------------------------------------------------------------

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
	throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set');
}

const client = createClient({ url, authToken });
const db = drizzle(client, { schema }) as unknown as Database;

const stamp = process.env.VERIFY_STAMP ?? String(process.hrtime.bigint());
const newSender = `us-e02-new-${stamp}@example.com`;
const manualSender = `us-e02-manual-${stamp}@example.com`;
const createdEmails: string[] = [];
const storedMessageIds: string[] = [];

try {
	console.log('\nupsertContactFromInbound — live DB');

	// (a) brand-new sender -> inserted, auto_created = true, name from payload
	const first = await upsertContactFromInbound(db, {
		email: newSender.toUpperCase(),
		name: 'Example Sender'
	});
	createdEmails.push(first.contact.email);
	check('new sender is created', first.created);
	equal('email is stored lowercased', first.contact.email, normalizeEmail(newSender));
	equal('name comes from the payload', first.contact.name, 'Example Sender');
	check('auto_created is true', first.contact.autoCreated);

	// (b) same sender, different casing -> matched, not duplicated
	const second = await upsertContactFromInbound(db, {
		email: newSender.replace('us-e02', 'US-E02'),
		name: 'Example Sender'
	});
	check('case-different address matches the same row', !second.created);
	equal('same contact id', second.contact.id, first.contact.id);
	const { rows } = await client.execute({
		sql: 'select count(*) as n from contacts where lower(email) = ?',
		args: [normalizeEmail(newSender)]
	});
	equal('exactly one row exists for the address', Number(rows[0].n), 1);

	// (c) auto-created contact DOES get a better name later
	const renamed = await upsertContactFromInbound(db, {
		email: newSender,
		name: 'Renamed Sender'
	});
	check('auto-created name is refreshed', renamed.nameUpdated);
	equal('new name persisted', renamed.contact.name, 'Renamed Sender');

	// (d) a payload with no display name never blanks an existing name
	const noName = await upsertContactFromInbound(db, { email: newSender, name: null });
	check('null payload name does not update', !noName.nameUpdated);
	equal('existing name preserved', noName.contact.name, 'Renamed Sender');

	// (e) manually-edited contact (auto_created = false) is never renamed
	await db
		.insert(contacts)
		.values({ email: normalizeEmail(manualSender), name: 'Hand Written', autoCreated: false });
	createdEmails.push(normalizeEmail(manualSender));
	const manual = await upsertContactFromInbound(db, {
		email: manualSender,
		name: 'Payload Name'
	});
	check('manually-edited contact is not renamed', !manual.nameUpdated);
	equal('hand-written name survives', manual.contact.name, 'Hand Written');
	check('auto_created stays false', !manual.contact.autoCreated);

	// (f) whitespace-only names are treated as absent
	const blank = await upsertContactFromInbound(db, { email: newSender, name: '   ' });
	check('whitespace-only name does not update', !blank.nameUpdated);

	// (g) lookup helper is case-insensitive
	const found = await getContactByEmail(db, newSender.toUpperCase());
	equal('getContactByEmail is case-insensitive', found?.id, first.contact.id);

	// -------------------------------------------------------------------------
	// storeInboundEmail — sanitize + idempotent insert (US-E03)
	// -------------------------------------------------------------------------
	console.log('\nstoreInboundEmail — live DB');

	// The subject is overridden with a per-run unique one on purpose. Keeping
	// `realDelivery.subject` would let this row subject-match (US-E04's 30-day
	// fallback) onto the thread `verify-inbound-webhook.mts` creates from the
	// same real email in this same live DB — making `threadMatch` depend on
	// which script ran last, and pointing cleanup at a thread holding real rows.
	const parsed = parseReceivedEmail({
		...realDelivery,
		subject: `US-E03 store fixture ${stamp}`,
		message_id: `<us-e03-${stamp}@example.com>`,
		headers: {
			...realDelivery.headers,
			'message-id': `<us-e03-${stamp}@example.com>`
		},
		html: '<p>hi</p><script>alert(1)</script><img src="x" onerror="y()">',
		text: '  hi\n\nplain  '
	} as GetReceivingEmailResponseSuccess);

	const stored = await storeInboundEmail(db, parsed);
	storedMessageIds.push(parsed.messageId);
	check('a new message_id is stored', stored.created);
	equal('direction is inbound', stored.email.direction, 'inbound');
	equal('body_html is sanitized on the way in', stored.email.bodyHtml, '<p>hi</p><img src="x">');
	equal('body_text is stored as-is', stored.email.bodyText, '  hi\n\nplain  ');
	equal('from_email', stored.email.fromEmail, 'sender@example.com');
	equal('to_emails round-trips as JSON', stored.email.toEmails, ['owner@example.com']);
	equal(
		'received_at from the Date: header',
		stored.email.receivedAt.toISOString(),
		'2026-07-25T15:15:31.000Z'
	);
	equal('a thread was created for it', stored.threadMatch, 'new');

	const { rows: threadRowsBefore } = await client.execute({
		sql: 'select subject from threads where id = ?',
		args: [stored.email.threadId]
	});
	equal(
		'the thread stores the normalized subject',
		threadRowsBefore[0]?.subject,
		`us-e03 store fixture ${stamp}`.toLowerCase()
	);

	// A redelivery of the same message_id must be a no-op, not a 500 — and must
	// not leave an orphan thread behind either, so the whole-table count is what
	// gets compared.
	const threadCount = async () =>
		Number((await client.execute('select count(*) as n from threads')).rows[0].n);
	const threadsBeforeReplay = await threadCount();
	const replay = await storeInboundEmail(db, parsed);
	check('redelivery is detected as a duplicate', !replay.created);
	equal('duplicate returns the original row', replay.email.id, stored.email.id);

	const { rows: emailRows } = await client.execute({
		sql: 'select count(*) as n from emails where message_id = ?',
		args: [parsed.messageId]
	});
	equal('still exactly one email row', Number(emailRows[0].n), 1);

	equal('the duplicate left no orphan thread', await threadCount(), threadsBeforeReplay);

	// -------------------------------------------------------------------------
	// Part 5 — thread assignment (US-E04, live DB)
	// -------------------------------------------------------------------------
	console.log('\nstoreInboundEmail — thread assignment');

	const now = new Date('2026-07-25T16:00:00.000Z');
	/** Builds a parsed inbound email with the fields threading cares about. */
	const inbound = (over: {
		id: string;
		subject: string;
		date: string;
		inReplyTo?: string;
		references?: string;
	}) =>
		parseReceivedEmail({
			...realDelivery,
			message_id: `<${over.id}@example.com>`,
			subject: over.subject,
			headers: {
				...realDelivery.headers,
				'message-id': `<${over.id}@example.com>`,
				date: JSON.stringify(over.date),
				...(over.inReplyTo ? { 'in-reply-to': over.inReplyTo } : {}),
				...(over.references ? { references: over.references } : {})
			}
		} as GetReceivingEmailResponseSuccess);

	const store = async (record: ReturnType<typeof inbound>) => {
		const result = await storeInboundEmail(db, record, now);
		storedMessageIds.push(record.messageId);
		return result;
	};

	const root = await store(
		inbound({
			id: `us-e04-root-${stamp}`,
			subject: 'Quarterly Report',
			date: '2026-07-25T10:00:00.000Z'
		})
	);
	equal('a fresh conversation starts a new thread', root.threadMatch, 'new');

	const [rootThread] = await db
		.select()
		.from(threads)
		.where(inArray(threads.id, [root.email.threadId]));
	equal('the thread stores the normalized subject', rootThread.subject, 'quarterly report');
	equal('a new unread message leaves the thread unread', rootThread.isRead, false);

	// Mark it read, so the next arrival has something to flip back.
	await client.execute({
		sql: 'update threads set is_read = 1 where id = ?',
		args: [root.email.threadId]
	});

	const reply = await store(
		inbound({
			id: `us-e04-reply-${stamp}`,
			subject: 'Re: Quarterly Report',
			date: '2026-07-25T11:00:00.000Z',
			inReplyTo: `<us-e04-root-${stamp}@example.com>`
		})
	);
	equal('In-Reply-To matches an existing message_id', reply.threadMatch, 'reply');
	equal('the reply joins the parent thread', reply.email.threadId, root.email.threadId);

	const [afterReply] = await db
		.select()
		.from(threads)
		.where(inArray(threads.id, [root.email.threadId]));
	equal('a new message makes a read thread unread again', afterReply.isRead, false);
	equal(
		'last_message_at moved to the reply',
		afterReply.lastMessageAt.toISOString(),
		'2026-07-25T11:00:00.000Z'
	);

	// A reply whose direct parent this mailbox never saw still threads off the
	// References chain.
	const viaReferences = await store(
		inbound({
			id: `us-e04-refs-${stamp}`,
			subject: 'Re: Quarterly Report',
			date: '2026-07-25T12:00:00.000Z',
			inReplyTo: `<us-e04-unknown-${stamp}@example.com>`,
			references: `<us-e04-root-${stamp}@example.com> <us-e04-unknown-${stamp}@example.com>`
		})
	);
	equal('an unknown parent falls through to References', viaReferences.threadMatch, 'reply');
	equal(
		'References threading picks the same thread',
		viaReferences.email.threadId,
		root.email.threadId
	);

	// No headers at all: FR-4's 30-day same-normalized-subject fallback.
	const bySubject = await store(
		inbound({
			id: `us-e04-subject-${stamp}`,
			subject: 'RE:   Quarterly Report',
			date: '2026-07-25T13:00:00.000Z'
		})
	);
	equal('headerless same-subject mail falls back to subject', bySubject.threadMatch, 'subject');
	equal('subject fallback picks the same thread', bySubject.email.threadId, root.email.threadId);

	// An older message arriving late must not drag the thread's sort key back.
	await store(
		inbound({
			id: `us-e04-late-${stamp}`,
			subject: 'Re: Quarterly Report',
			date: '2026-07-20T09:00:00.000Z',
			inReplyTo: `<us-e04-root-${stamp}@example.com>`
		})
	);
	const [afterLate] = await db
		.select()
		.from(threads)
		.where(inArray(threads.id, [root.email.threadId]));
	equal(
		'a late older message does not move last_message_at back',
		afterLate.lastMessageAt.toISOString(),
		'2026-07-25T13:00:00.000Z'
	);

	// Outside the 30-day window, the same subject starts a fresh conversation.
	const stale = await storeInboundEmail(
		db,
		inbound({
			id: `us-e04-stale-${stamp}`,
			subject: 'Quarterly Report',
			date: '2026-09-30T10:00:00.000Z'
		}),
		new Date('2026-09-30T10:00:00.000Z')
	);
	storedMessageIds.push(`<us-e04-stale-${stamp}@example.com>`);
	equal('the same subject 60+ days later is a new thread', stale.threadMatch, 'new');
	check('and it is genuinely a different thread', stale.email.threadId !== root.email.threadId);

	const unrelated = await store(
		inbound({
			id: `us-e04-other-${stamp}`,
			subject: 'Something else entirely',
			date: '2026-07-25T14:00:00.000Z'
		})
	);
	equal('an unrelated subject starts its own thread', unrelated.threadMatch, 'new');
	check('unrelated mail is not merged', unrelated.email.threadId !== root.email.threadId);
} finally {
	if (storedMessageIds.length > 0) {
		const doomed = await db
			.select({ id: emails.id, threadId: emails.threadId })
			.from(emails)
			.where(inArray(emails.messageId, storedMessageIds));
		await db.delete(emails).where(inArray(emails.messageId, storedMessageIds));

		// Only drop a thread that is now *empty*. A thread this run merely joined
		// may still hold rows it did not create — including real user mail — and
		// deleting it would either throw SQLITE_CONSTRAINT out of `finally` (the
		// remote Turso connection enforces FKs) and mask the run's results, or,
		// worse, destroy genuine data. Same guard the sibling webhook script uses.
		const threadIds = [...new Set(doomed.map((row) => row.threadId))];
		let removedThreads = 0;
		for (const threadId of threadIds) {
			const { rowsAffected } = await client.execute({
				sql: 'delete from threads where id = ? and not exists (select 1 from emails where thread_id = ?)',
				args: [threadId, threadId]
			});
			removedThreads += Number(rowsAffected);
		}
		console.log(
			`cleanup: ${doomed.length} email row(s) and ${removedThreads} thread row(s) removed`
		);
	}

	if (createdEmails.length > 0) {
		await db.delete(contacts).where(inArray(contacts.email, createdEmails));
		const { rows } = await client.execute({
			sql: `select count(*) as n from contacts where email in (${createdEmails.map(() => '?').join(',')})`,
			args: createdEmails
		});
		console.log(`\ncleanup: ${createdEmails.length} row(s) removed, ${rows[0].n} remaining`);
	}
	client.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
