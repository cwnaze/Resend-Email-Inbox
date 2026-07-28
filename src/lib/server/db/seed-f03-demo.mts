// Throwaway seeding helper for the US-F03 browser demo: two threads (one read,
// one unread) plus a login code, and a `--cleanup` mode that removes them again.
// Kept in the repo for the demo's reproducibility, not part of the app.
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq, like } from 'drizzle-orm';
import * as schema from './schema.js';
import { authCodes, emails, threads } from './schema.js';
import { hashAuthCode } from '../auth/auth-codes.js';

const STAMP = 'f03-demo';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

const client = createClient({
	url: requireEnv('TURSO_DATABASE_URL'),
	authToken: requireEnv('TURSO_AUTH_TOKEN')
});
const db = drizzle(client, { schema });

const cleanup = process.argv.includes('--cleanup');

// Children before parents: the remote Turso connection enforces the FK.
async function removeSeededRows() {
	await db.delete(emails).where(like(emails.messageId, `<${STAMP}%`));
	await db.delete(threads).where(like(threads.subject, `${STAMP}%`));
	await db.delete(authCodes).where(eq(authCodes.codeHash, hashAuthCode('123456')));
}

if (cleanup) {
	await removeSeededRows();
	console.log('cleaned up');
} else {
	// Idempotent, so the demo can be re-run: `message_id` is unique.
	await removeSeededRows();
	const base = new Date('2020-01-01T00:00:00.000Z').getTime();
	const [unread, read] = await db
		.insert(threads)
		.values([
			{ subject: `${STAMP} unread thread`, lastMessageAt: new Date(base + 60_000), isRead: false },
			{ subject: `${STAMP} read thread`, lastMessageAt: new Date(base), isRead: true }
		])
		.returning();

	await db.insert(emails).values([
		{
			threadId: unread.id,
			messageId: `<${STAMP}-unread@invalid>`,
			direction: 'inbound' as const,
			fromEmail: 'unread@example.com',
			fromName: 'Unread Sender',
			toEmails: ['owner@example.com'],
			subject: `${STAMP} unread thread`,
			bodyText: 'This one is unread.',
			isRead: false,
			receivedAt: new Date(base + 60_000)
		},
		{
			threadId: read.id,
			messageId: `<${STAMP}-read@invalid>`,
			direction: 'inbound' as const,
			fromEmail: 'read@example.com',
			fromName: 'Read Sender',
			toEmails: ['owner@example.com'],
			subject: `${STAMP} read thread`,
			bodyText: 'This one is read.',
			isRead: true,
			receivedAt: new Date(base)
		}
	]);

	await db.insert(authCodes).values({
		codeHash: hashAuthCode('123456'),
		expiresAt: new Date(Date.now() + 10 * 60_000)
	});

	console.log('seeded');
}

client.close();
