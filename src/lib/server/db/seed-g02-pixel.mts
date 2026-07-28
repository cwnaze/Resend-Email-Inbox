// Demo seeder for US-G02's body-precedence case: one thread whose single message
// has a readable **text** body plus an HTML part that is nothing but a hidden
// preheader and a 1×1 tracking pixel — the shape a lot of transactional mail
// takes. That HTML sanitizes to non-empty markup which renders *blank*, so
// preferring it unconditionally would replace the readable text with an empty
// frame and a "1 remote image blocked" notice. `--cleanup` removes the rows.
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
		}
	]);
	console.log('seeded pixel thread');
} else {
	console.log('cleaned pixel thread');
}
client.close();
