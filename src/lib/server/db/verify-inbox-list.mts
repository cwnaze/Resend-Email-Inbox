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
import { getThreadById, listThreadEmails, markThreadRead } from './emails.js';
import { inboxSearchLikePattern, listInboxThreads } from './inbox.js';
import {
	absoluteTime,
	addressListLabel,
	bodyPlainText,
	bodySnippet,
	htmlToPlainText,
	relativeTime,
	senderLabel
} from '../../inbox/format.js';
import { inboxFilterSearch, parseInboxFilter } from '../../inbox/filter.js';
import { inboxSearchSearch, parseInboxQuery } from '../../inbox/search.js';
import { BLOCKED_IMAGE_ATTR, buildEmailSrcdoc, restoreBlockedImages } from '../../inbox/srcdoc.js';
import { prepareEmailHtml } from '../inbox/html.js';
import { sanitizeEmailHtml } from '../inbound/sanitize.js';

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
// Pure: the thread view's formatters (US-G01)
// ---------------------------------------------------------------------------

console.log('htmlToPlainText / bodyPlainText');
equal(
	'keeps a blank line between block elements',
	htmlToPlainText('<p>one</p><p>two</p>'),
	'one\n\ntwo'
);
equal('turns a <br> into a single newline', htmlToPlainText('a<br>b'), 'a\nb');
equal(
	'collapses indentation without collapsing the line structure',
	htmlToPlainText('<p>\n\t\tone   word\n</p>\n<p>  two  </p>'),
	'one word\n\ntwo'
);
equal(
	'caps a run of empty blocks at one blank line',
	htmlToPlainText('<p>one</p><div></div><div></div><p>two</p>'),
	'one\n\ntwo'
);
equal('drops style/script content', htmlToPlainText('<style>p{color:red}</style><p>B</p>'), 'B');
equal(
	'decodes entities, and does not double-decode an escaped one',
	htmlToPlainText('<p>Tom &amp; Jerry, &amp;lt;not a tag&amp;gt;</p>'),
	'Tom & Jerry, &lt;not a tag&gt;'
);
equal('empty markup yields an empty string', htmlToPlainText('<div></div>'), '');
equal(
	'bodyPlainText prefers the text body and keeps its line breaks',
	bodyPlainText('line one\nline two\n\n', '<p>ignored</p>'),
	'line one\nline two'
);
equal(
	'bodyPlainText falls back to de-tagged HTML',
	bodyPlainText(null, '<p>from html</p>'),
	'from html'
);
equal(
	'bodyPlainText treats a whitespace-only text body as absent',
	bodyPlainText(' \n ', null),
	''
);
equal('bodyPlainText with no body at all is empty', bodyPlainText(null, null), '');
equal(
	'bodyPlainText normalizes CRLF in a text body',
	bodyPlainText('a\r\nb', null),
	// A stray \r would render as a control character in the reading view.
	'a\nb'
);

console.log('addressListLabel');
equal(
	'joins addresses with commas',
	addressListLabel(['a@example.com', 'b@example.com']),
	'a@example.com, b@example.com'
);
equal('a null list renders no line', addressListLabel(null), '');
equal('an empty list renders no line', addressListLabel([]), '');
equal('a list of blanks renders no line', addressListLabel(['', '  ']), '');
equal(
	'blank entries are dropped, not joined as gaps',
	addressListLabel(['a@x.com', ' ']),
	'a@x.com'
);

console.log('absoluteTime');
// Asserted as a shape rather than an exact string: the output is rendered in
// the running machine's timezone, so pinning "3:15 PM" would only pass in one.
// `\s` rather than a literal space: current ICU separates the clock time from
// the AM/PM marker with a narrow no-break space (U+202F).
const stampedTime = absoluteTime(new Date('2026-07-25T15:15:00.000Z'));
check(
	'renders month, day, year and a 12-hour clock time',
	/^[A-Z][a-z]{2} \d{1,2}, 2026, \d{1,2}:\d{2}\s?(AM|PM)$/.test(stampedTime),
	stampedTime
);
check('includes the year, unlike the list’s relative label', stampedTime.includes('2026'));

// ---------------------------------------------------------------------------
// Pure: the read/unread filter (US-F03)
// ---------------------------------------------------------------------------

console.log('parseInboxFilter');
equal('accepts all', parseInboxFilter('all'), 'all');
equal('accepts unread', parseInboxFilter('unread'), 'unread');
equal('accepts read', parseInboxFilter('read'), 'read');
equal('defaults a missing param to all', parseInboxFilter(null), 'all');
equal('defaults an unknown value to all rather than erroring', parseInboxFilter('UNREAD'), 'all');
equal('defaults an empty value to all', parseInboxFilter(''), 'all');

console.log('inboxFilterSearch');
equal(
	'sets the param for a non-default filter',
	inboxFilterSearch(new URLSearchParams(), 'unread'),
	'?filter=unread'
);
equal(
	'drops the param for the default filter',
	inboxFilterSearch(new URLSearchParams('filter=unread'), 'all'),
	''
);
equal(
	'preserves other params when switching filter (FR-3)',
	inboxFilterSearch(new URLSearchParams('q=invoice&filter=read'), 'unread'),
	'?q=invoice&filter=unread'
);
equal(
	'preserves other params when clearing the filter',
	inboxFilterSearch(new URLSearchParams('filter=read&q=invoice'), 'all'),
	'?q=invoice'
);

// ---------------------------------------------------------------------------
// Pure: subject/sender search (US-F04)
// ---------------------------------------------------------------------------

console.log('parseInboxQuery');
equal('keeps a plain query', parseInboxQuery('invoice'), 'invoice');
equal('trims surrounding whitespace', parseInboxQuery('  invoice  '), 'invoice');
equal('collapses internal whitespace', parseInboxQuery('invoice   #4'), 'invoice #4');
equal('a missing param is no search', parseInboxQuery(null), '');
equal('a whitespace-only param is no search, not a %% match', parseInboxQuery('   '), '');
check('caps the length', parseInboxQuery('a'.repeat(500)).length === 200);

console.log('inboxSearchSearch');
equal('sets the query param', inboxSearchSearch(new URLSearchParams(), 'invoice'), '?q=invoice');
equal(
	'preserves the filter when searching (FR-3)',
	inboxSearchSearch(new URLSearchParams('filter=unread'), 'invoice'),
	'?filter=unread&q=invoice'
);
equal(
	'clearing drops the param but keeps the filter',
	inboxSearchSearch(new URLSearchParams('filter=unread&q=invoice'), ''),
	'?filter=unread'
);
equal(
	'a whitespace-only query clears rather than searching for nothing',
	inboxSearchSearch(new URLSearchParams('q=invoice'), '   '),
	''
);

console.log('inboxSearchLikePattern');
equal('wraps in wildcards and lowercases', inboxSearchLikePattern('InVoice'), '%invoice%');
equal('escapes a literal percent', inboxSearchLikePattern('50%'), '%50\\%%');
equal('escapes a literal underscore', inboxSearchLikePattern('a_b'), '%a\\_b%');
equal('escapes the escape character itself', inboxSearchLikePattern('a\\b'), '%a\\\\b%');

// ---------------------------------------------------------------------------
// Pure: prepareEmailHtml + the srcdoc builder (US-G02)
// ---------------------------------------------------------------------------

console.log('prepareEmailHtml');
equal('returns null for a null body', prepareEmailHtml(null), null);
equal('returns null for a blank body', prepareEmailHtml('   '), null);
equal(
	'returns null for a body that is entirely stripped',
	prepareEmailHtml('<script>alert(1)</script>'),
	null
);

const plainHtml = prepareEmailHtml('<p>Hello <strong>there</strong></p>')!;
equal('keeps prose markup', plainHtml.html, '<p>Hello <strong>there</strong></p>');
equal('counts no blocked images when there are none', plainHtml.blockedImageCount, 0);

const remoteImage = prepareEmailHtml('<p>hi</p><img src="https://tracker.example/px.gif">')!;
check(
	'moves a remote image src onto the blocked attribute',
	remoteImage.html.includes(`${BLOCKED_IMAGE_ATTR}="https://tracker.example/px.gif"`),
	remoteImage.html
);
check('leaves no src attribute behind', !/\ssrc=/.test(remoteImage.html), remoteImage.html);
equal('counts the blocked image', remoteImage.blockedImageCount, 1);

equal(
	'counts every blocked image',
	prepareEmailHtml('<img src="http://a/1.png"><img src="//b/2.png">')!.blockedImageCount,
	2
);

const dataImage = prepareEmailHtml('<img src="data:image/gif;base64,R0lGOD">')!;
check('leaves a data: image loading', dataImage.html.includes('src="data:image'), dataImage.html);
equal('does not count a data: image as blocked', dataImage.blockedImageCount, 0);
equal(
	'does not count a cid: image as blocked (nothing to load)',
	prepareEmailHtml('<img src="cid:part1@example">')!.blockedImageCount,
	0
);

const scripted = prepareEmailHtml(
	'<p onclick="x()">hi</p><script>alert(1)</script><iframe src="https://e"></iframe>'
)!;
check('strips scripts', !/script/i.test(scripted.html), scripted.html);
check('strips event handlers', !/onclick/i.test(scripted.html), scripted.html);
check('strips nested iframes', !/iframe/i.test(scripted.html), scripted.html);

const smuggled = prepareEmailHtml(`<img ${BLOCKED_IMAGE_ATTR}="https://evil.example/px.gif">`)!;
equal(
	'a sender-supplied blocked-src attribute does not survive to be restored',
	restoreBlockedImages(smuggled.html).includes('evil.example'),
	false
);

const media = prepareEmailHtml('<video src="https://v/x.mp4" poster="https://v/p.png"></video>')!;
check('drops remote media src outright', !/https:\/\/v\//.test(media.html), media.html);

// A `javascript:` src is removed by DOMPurify's own URI allow-list before this
// pass sees the element, so parking can never restore a scheme the sanitizer
// refused. This is the check that pins that ordering.
const scriptUri = prepareEmailHtml('<p>x</p><img src="javascript:alert(1)">')!;
check(
	'never parks a javascript: src',
	!/javascript:/i.test(scriptUri.html) && scriptUri.blockedImageCount === 0,
	scriptUri.html
);
check(
	'a meta refresh cannot survive to redirect the frame',
	prepareEmailHtml('<meta http-equiv="refresh" content="0;url=https://evil.example">') === null
);

console.log('body choice: hasVisibleText / hasDefiniteImage / blockedImageCount');
// The rule these back, and the reason it is shaped this way: the text part is
// dropped ONLY when the HTML has real text of its own. Six review rounds of
// deciding it from a size heuristic over the images produced a bypass at every
// threshold (`width="4"`, then `width="17"`), and each bypass silently discarded a
// readable message. So the heuristic no longer gets to decide that — it only
// decides whether a frame is worth mounting.
const text = (html: string) => prepareEmailHtml(html)?.hasVisibleText ?? null;
const definite = (html: string) => prepareEmailHtml(html)?.hasDefiniteImage ?? null;
const blocked = (html: string) => prepareEmailHtml(html)?.blockedImageCount ?? null;

equal('prose is visible text', text('<p>Hello</p>'), true);
equal('markup with nothing in it is not', text('<div><br></div>'), false);
equal(
	'an image-only body has no visible text',
	text('<img src="https://cdn/h.png" width="600">'),
	false
);
equal(
	'a style-hidden preheader still counts as visible text (style is stripped on write)',
	text('<div style="display:none">preheader junk</div>'),
	true
);
equal(
	'text inside a [hidden] element does not (it renders nothing)',
	text('<div hidden>x</div>'),
	false
);
check(
	'...but the hidden element is still rendered as written (the text test must not mutate the body)',
	prepareEmailHtml('<div hidden>keepme</div><p>hi</p>')!.html.includes('keepme')
);

equal(
	'a hero image with px dimensions is a definite image',
	definite('<img src="https://cdn/h.png" width="600" height="400">'),
	true
);
equal(
	'a responsive hero sized in % is too',
	definite('<img src="https://cdn/h.png" width="100%">'),
	true
);
equal(
	'a 1x1 tracking pixel is not',
	definite('<img src="https://t/o.gif" width="1" height="1">'),
	false
);
equal(
	'a 600x1 spacer rule is not',
	definite('<img src="https://cdn/r.png" width="600" height="1">'),
	false
);
equal(
	'a 16x16 logo is not',
	definite('<img src="https://cdn/logo.png" width="16" height="16">'),
	false
);
equal(
	'a 17x17 image is',
	definite('<img src="https://cdn/logo.png" width="17" height="17">'),
	true
);
equal(
	'a dimensionless image is not (CSS-sized trackers are the common kind)',
	definite('<img src="https://t/o.gif?id=1">'),
	false
);
equal(
	'an image whose src the sanitizer removed is not',
	definite('<p><img src="javascript:alert(1)" width="600"></p>'),
	false
);
equal(
	'a definite-size image inside a [hidden] subtree is not (it renders blank)',
	definite('<div hidden><img src="https://t/p.gif" width="600" height="400"></div>'),
	false
);
equal(
	'a px unit on a real size still counts',
	definite('<img src="https://cdn/h.png" width="600px">'),
	true
);
equal('a decimal size still counts', definite('<img src="https://cdn/h.png" width="600.5">'), true);
equal(
	'a px unit on a pixel size is still a pixel',
	definite('<img src="https://t/o.gif" width="1px" height="1px">'),
	false
);
equal(
	'a non-numeric size is not evidence either way',
	definite('<img src="https://t/o.gif" width="abc">'),
	false
);
equal(
	'a small number inside the parked URL cannot demote a real image',
	definite('<img src="https://cdn.example/hero.png?crop=1&h=1&height=2" width="600" height="200">'),
	true
);
equal(
	'alt text mentioning width=1 cannot demote a real image',
	definite(
		'<img src="https://cdn/hero.png" width="600" height="400" alt="chart width=1 height=1">'
	),
	true
);

// A `cid:`/`data:` image is never "blocked" (nothing to load, nobody to reach), so
// a body whose only content is one mounts no frame — the honest "no body" line
// renders instead of a blank frame with no notice and no toggle.
equal('a cid: image is not counted as blocked', blocked('<img src="cid:img001">'), 0);
equal(
	'a data: image is not counted as blocked',
	blocked('<img src="data:image/gif;base64,R0lGOD">'),
	0
);
equal('a remote image is', blocked('<img src="https://t/o.gif">'), 1);

// `<template>` keeps its children in a separate fragment `querySelectorAll` cannot
// reach, so the read path drops the element outright...
check(
	'the read path drops <template> so its content cannot hide a remote image',
	prepareEmailHtml('<p>hi</p><template><img src="http://t/px.gif"></template>')!.html ===
		'<p>hi</p>'
);
// ...but the *write* path must not, or the only copy of the message loses the text
// inside it (DOMPurify's default FORBID_CONTENTS includes `template`, and
// AMP-for-Email bodies carry their content exactly that way).
check(
	'the write path keeps text inside a <template> rather than deleting it',
	(sanitizeEmailHtml('<div><template>Order shipped!</template></div>') ?? '').includes(
		'Order shipped!'
	),
	sanitizeEmailHtml('<div><template>Order shipped!</template></div>')
);

console.log('buildEmailSrcdoc');
const blockedDoc = buildEmailSrcdoc(remoteImage.html);
check('is a full document', blockedDoc.startsWith('<!doctype html>'), blockedDoc.slice(0, 40));
check(
	'restricts img-src to data: while images are blocked',
	blockedDoc.includes("default-src 'none'; img-src data:;"),
	blockedDoc
);
check(
	'keeps the image blocked in the document body',
	blockedDoc.includes(BLOCKED_IMAGE_ATTR) && !/\ssrc=/.test(blockedDoc),
	blockedDoc
);

check(
	'forces every link into a new browsing context, which the sandbox then blocks',
	blockedDoc.includes('<base target="_blank">'),
	blockedDoc
);

const loadedDoc = buildEmailSrcdoc(remoteImage.html, { showImages: true });
// The stylesheet mentions the attribute too (that's the placeholder selector),
// so the "nothing is still blocked" half has to look at the body, not the
// whole document.
const loadedBody = loadedDoc.slice(loadedDoc.indexOf('<body>'));
check(
	'restores the src once images are loaded',
	loadedBody.includes('src="https://tracker.example/px.gif"') &&
		!loadedBody.includes(BLOCKED_IMAGE_ATTR),
	loadedBody
);
check(
	'opens img-src for remote schemes once images are loaded',
	loadedDoc.includes('img-src data: https: http:;'),
	loadedDoc
);
equal(
	'restoreBlockedImages is a no-op on markup with nothing blocked',
	restoreBlockedImages('<p>plain</p>'),
	'<p>plain</p>'
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
				toEmails: ['owner@example.com', 'other@example.com'],
				ccEmails: ['cc-one@example.com', 'cc-two@example.com'],
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
	// The read/unread filter (US-F03)
	// -------------------------------------------------------------------------

	console.log('listInboxThreads — filter (US-F03)');

	const mine = (rows: Awaited<ReturnType<typeof listInboxThreads>>) =>
		rows.filter((row) => threadIds.includes(row.threadId)).map((row) => row.threadSubject);

	equal(
		'filter=unread hides threads where is_read is true',
		mine(await listInboxThreads(db, { limit: 200, filter: 'unread' })),
		[`${stamp} newer`, `${stamp} multi`]
	);
	equal(
		'filter=read hides unread threads, and still excludes the soft-deleted-only one',
		mine(await listInboxThreads(db, { limit: 200, filter: 'read' })),
		[`${stamp} older`]
	);
	equal(
		'filter=all matches the unfiltered default',
		mine(await listInboxThreads(db, { limit: 200, filter: 'all' })),
		mine(rows)
	);

	// -------------------------------------------------------------------------
	// Subject/sender search (US-F04)
	// -------------------------------------------------------------------------

	console.log('listInboxThreads — search (US-F04)');

	const found = async (query: string, filter?: 'all' | 'unread' | 'read') =>
		mine(await listInboxThreads(db, { limit: 200, filter, query }));

	equal('matches a subject substring', await found('older'), [`${stamp} older`]);
	equal('is case-insensitive', await found('OLDER'), [`${stamp} older`]);
	equal('matches every seeded thread on the shared stamp, in list order', await found(stamp), [
		`${stamp} newer`,
		`${stamp} multi`,
		`${stamp} older`
	]);
	equal(
		'matches the sender address of a member email that is not the preview',
		await found('first@example.com'),
		[`${stamp} multi`]
	);
	equal('matches a sender display name', await found('second sender'), [`${stamp} multi`]);
	equal('ignores the sender of a soft-deleted email', await found('third@example.com'), []);
	equal('a query with no hits returns nothing', await found(`${stamp} nothing-matches`), []);
	equal('a bare wildcard is matched literally, not as "everything"', await found('%'), []);
	equal('search and filter narrow together (FR-3)', await found(stamp, 'unread'), [
		`${stamp} newer`,
		`${stamp} multi`
	]);
	equal('a whitespace-only query is not a search', await found('   '), [
		`${stamp} newer`,
		`${stamp} multi`,
		`${stamp} older`
	]);

	// -------------------------------------------------------------------------
	// listThreadEmails (US-G01)
	// -------------------------------------------------------------------------

	console.log('listThreadEmails — live DB');

	const threadEmails = await listThreadEmails(db, multi.id);
	equal(
		'returns every visible message oldest first, excluding the soft-deleted one',
		threadEmails.map((row) => row.subject),
		['First in thread', 'Second in thread']
	);
	check(
		'is the ascending mirror of the list’s newest-first preview pick',
		threadEmails[0].receivedAt.getTime() < threadEmails[1].receivedAt.getTime()
	);
	equal(
		'carries the recipients the thread view renders',
		addressListLabel(threadEmails[1].toEmails),
		'owner@example.com, other@example.com'
	);
	equal(
		'carries the cc list',
		addressListLabel(threadEmails[1].ccEmails),
		'cc-one@example.com, cc-two@example.com'
	);
	equal(
		'renders no cc line for an email without one',
		addressListLabel(threadEmails[0].ccEmails),
		''
	);
	equal(
		'a single-email thread returns just that email',
		(await listThreadEmails(db, newer.id)).map((row) => row.subject),
		['Newer subject']
	);
	equal(
		'a thread whose only email is soft-deleted has no visible message (the load 404s on this)',
		await listThreadEmails(db, deletedOnly.id),
		[]
	);
	equal(
		'an unknown thread id yields no messages',
		await listThreadEmails(db, `${stamp}-missing`),
		[]
	);

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
