// Demo seeder for US-G02's body-precedence cases — three threads, one per shape:
//
// 1. text body + an HTML part that is only a spacer and a 1×1 tracking pixel.
//    The HTML sanitizes to non-empty markup that renders *blank*, so preferring it
//    would replace readable text with an empty frame and a "1 image blocked" notice.
// 2. an image-only HTML part (a hero image) + a "view in browser" text stub. Here
//    the HTML *is* the message, so demanding text would throw the real body away.
// 3. an HTML part that renders nothing and no text part at all, which must show the
//    explicit "no body" line rather than an empty frame.
//
// `--cleanup` removes the rows.
//
// Deliberately separate from `seed-f03-demo.mts` rather than another message in
// its conversation: US-G01's demo asserts that thread renders exactly two
// messages, and adding a third would break that demo's `showboat verify`.
//
// Prints no row ids, same reason as the other seeder: `showboat verify` re-runs
// it, so a pasted UUID could never reproduce. Reach the thread by searching.
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { like } from 'drizzle-orm';
import * as schema from './schema.js';

const { emails, threads } = schema;
const client = createClient({
	url: process.env.TURSO_DATABASE_URL!,
	authToken: process.env.TURSO_AUTH_TOKEN!
});
const db = drizzle(client, { schema });
const STAMP = 'g02-pixel';

await db.delete(emails).where(like(emails.messageId, `<${STAMP}%`));
await db.delete(threads).where(like(threads.subject, `${STAMP}%`));

if (!process.argv.includes('--cleanup')) {
	const at = new Date('2019-06-01T00:00:00.000Z');
	const [thread] = await db
		.insert(threads)
		.values([{ subject: `${STAMP} pixel only`, lastMessageAt: at, isRead: false }])
		.returning();
	const [hero] = await db
		.insert(threads)
		.values([
			{
				subject: `${STAMP} hero image only`,
				lastMessageAt: new Date(at.getTime() + 1000),
				isRead: false
			}
		])
		.returning();
	await db.insert(emails).values([
		{
			threadId: thread.id,
			messageId: `<${STAMP}-1@invalid>`,
			direction: 'inbound' as const,
			fromEmail: 'billing@example.com',
			fromName: 'Billing',
			toEmails: ['owner@example.com'],
			subject: `${STAMP} pixel only`,
			bodyText: 'Your code is 480912.',
			bodyHtml: '<div>&nbsp;</div><img src="https://track.example/o.gif" width="1" height="1">',
			isRead: false,
			receivedAt: at
		},
		// The mirror-image case: an image-only retail email whose text part is just
		// a "view in browser" stub. Here the HTML *is* the message, so it must win.
		// The URL deliberately carries a `?h=1` parameter: dimensions must come from
		// the element's attributes, not from a regex over the serialized tag.
		{
			threadId: hero.id,
			messageId: `<${STAMP}-2@invalid>`,
			direction: 'inbound' as const,
			fromEmail: 'shop@example.com',
			fromName: 'The Shop',
			toEmails: ['owner@example.com'],
			subject: `${STAMP} hero image only`,
			bodyText: 'View this email in your browser',
			bodyHtml:
				'<p><img src="https://cdn.example/hero.png" alt="Summer sale" width="600" height="200"></p>',
			isRead: false,
			receivedAt: new Date(at.getTime() + 1000)
		}
	]);
	const [blank] = await db
		.insert(threads)
		.values([
			{
				subject: `${STAMP} nothing to show`,
				lastMessageAt: new Date(at.getTime() + 2000),
				isRead: false
			}
		])
		.returning();
	await db.insert(emails).values([
		{
			threadId: blank.id,
			messageId: `<${STAMP}-3@invalid>`,
			direction: 'inbound' as const,
			fromEmail: 'noreply@example.com',
			toEmails: ['owner@example.com'],
			subject: `${STAMP} nothing to show`,
			// Renders nothing at all, and there is no text part to fall back to.
			bodyHtml: '<div><br></div>',
			isRead: false,
			receivedAt: new Date(at.getTime() + 2000)
		}
	]);

	console.log('seeded pixel thread');
} else {
	console.log('cleaned pixel thread');
}
client.close();
