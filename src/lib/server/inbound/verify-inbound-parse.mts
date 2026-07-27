// Standalone smoke test for US-E02: inbound payload parsing + contact upsert.
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

	const parsed = parseReceivedEmail({
		...realDelivery,
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
	check('a thread was created for it', typeof stored.email.threadId === 'string');

	const { rows: threadRowsBefore } = await client.execute({
		sql: 'select count(*) as n from threads where id = ?',
		args: [stored.email.threadId]
	});
	equal('exactly one thread row', Number(threadRowsBefore[0].n), 1);

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
} finally {
	if (storedMessageIds.length > 0) {
		const doomed = await db
			.select({ id: emails.id, threadId: emails.threadId })
			.from(emails)
			.where(inArray(emails.messageId, storedMessageIds));
		await db.delete(emails).where(inArray(emails.messageId, storedMessageIds));
		const threadIds = doomed.map((row) => row.threadId);
		if (threadIds.length > 0) {
			await db.delete(threads).where(inArray(threads.id, threadIds));
		}
		console.log(
			`cleanup: ${doomed.length} email row(s) and ${threadIds.length} thread row(s) removed`
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
