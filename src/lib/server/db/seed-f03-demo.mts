// Throwaway seeding helper for the inbox browser demos, added for US-F03 and
// extended since: a read thread, an unread thread, a multi-message conversation
// for the US-G01 thread view, and a login code — plus a `--cleanup` mode that
// removes them again. Kept in the repo for the demos' reproducibility, not part
// of the app.
//
// It deliberately prints no row ids: a demo that pasted a generated UUID into a
// URL could not be re-run by `showboat verify`. Reach the seeded thread by
// searching the list for the stamp and clicking the row instead.
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
// US-G01: soft-deletes every message in the seeded conversation, so the demo can
// show the "thread with no visible messages" 404 without hand-editing rows.
const hideConversation = process.argv.includes('--hide-conversation');

// Children before parents: the remote Turso connection enforces the FK.
async function removeSeededRows() {
	await db.delete(emails).where(like(emails.messageId, `<${STAMP}%`));
	await db.delete(threads).where(like(threads.subject, `${STAMP}%`));
	await db.delete(authCodes).where(eq(authCodes.codeHash, hashAuthCode('123456')));
}

if (cleanup) {
	await removeSeededRows();
	console.log('cleaned up');
} else if (hideConversation) {
	await db
		.update(emails)
		.set({ isDeleted: true })
		.where(like(emails.messageId, `<${STAMP}-conv%`));
	console.log('conversation hidden');
} else {
	// Idempotent, so the demo can be re-run: `message_id` is unique.
	await removeSeededRows();
	const base = new Date('2020-01-01T00:00:00.000Z').getTime();
	const [unread, read, conversation] = await db
		.insert(threads)
		.values([
			{ subject: `${STAMP} unread thread`, lastMessageAt: new Date(base + 60_000), isRead: false },
			{ subject: `${STAMP} read thread`, lastMessageAt: new Date(base), isRead: true },
			// The US-G01 thread view needs a thread with more than one message,
			// recipients on more than one line, an HTML-only body, and a
			// soft-deleted message that must *not* appear.
			{
				subject: `${STAMP} conversation`,
				lastMessageAt: new Date(base + 180_000),
				isRead: false
			}
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
		},
		{
			threadId: conversation.id,
			messageId: `<${STAMP}-conv-1@invalid>`,
			direction: 'inbound' as const,
			fromEmail: 'ada@example.com',
			fromName: 'Ada Lovelace',
			toEmails: ['owner@example.com'],
			subject: `${STAMP} conversation`,
			bodyText: 'First message in the conversation.\n\nWith a second paragraph.',
			isRead: false,
			receivedAt: new Date(base + 120_000)
		},
		{
			threadId: conversation.id,
			messageId: `<${STAMP}-conv-2@invalid>`,
			direction: 'inbound' as const,
			fromEmail: 'grace@example.com',
			fromName: 'Grace Hopper',
			toEmails: ['owner@example.com', 'ada@example.com'],
			ccEmails: ['team@example.com'],
			subject: `Re: ${STAMP} conversation`,
			// HTML-only, to exercise the de-tagged rendering path.
			bodyHtml: '<p>Second message, HTML only.</p><p>Second paragraph.</p>',
			isRead: false,
			receivedAt: new Date(base + 180_000)
		},
		{
			threadId: conversation.id,
			messageId: `<${STAMP}-conv-3@invalid>`,
			direction: 'inbound' as const,
			fromEmail: 'deleted@example.com',
			toEmails: ['owner@example.com'],
			subject: `Re: ${STAMP} conversation (deleted)`,
			bodyText: 'This message is soft-deleted and must not be rendered.',
			isDeleted: true,
			isRead: true,
			receivedAt: new Date(base + 240_000)
		}
	]);

	await db.insert(authCodes).values({
		codeHash: hashAuthCode('123456'),
		expiresAt: new Date(Date.now() + 10 * 60_000)
	});

	console.log('seeded');
}

client.close();
