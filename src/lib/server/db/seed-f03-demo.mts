// Throwaway seeding helper for the inbox browser demos, added for US-F03 and
// extended since: a read thread, an unread thread, a multi-message conversation
// for the US-G01 thread view, attachments (US-G03) on two of its messages, and a
// login code — plus a `--cleanup` mode that removes them again, R2 objects
// included. Kept in the repo for the demos' reproducibility, not part of the app.
//
// It deliberately prints no row ids: a demo that pasted a generated UUID into a
// URL could not be re-run by `showboat verify`. Reach the seeded thread by
// searching the list for the stamp and clicking the row instead.
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq, like } from 'drizzle-orm';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as schema from './schema.js';
import { attachments, authCodes, contacts, emails, threads } from './schema.js';
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

// US-G03: the attachment demo needs objects that actually exist in the bucket,
// or the download link presigns a key R2 answers 404 for. `$lib/server/r2` reads
// `$env/dynamic/private` and so can't be imported under bare `tsx` — same
// constraint `r2/verify.mts` works around, and the same way.
const r2 = new S3Client({
	region: 'auto',
	endpoint: `https://${requireEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
		secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY')
	}
});
const bucket = requireEnv('R2_BUCKET_NAME');

/**
 * The demo attachments. Deliberately tiny and text-based so the bytes are
 * assertable from a verification script, and one per interesting case: a plain
 * file, a name that needs the `filename*` header form, and one hanging off the
 * soft-deleted message (which must stay unreachable).
 */
const DEMO_FILES = [
	{
		slot: 'conv-1' as const,
		filename: 'notes.txt',
		contentType: 'text/plain',
		body: 'Attachment one, downloaded through a presigned R2 URL.\n'
	},
	{
		slot: 'conv-1' as const,
		filename: 'rapport-café.txt',
		contentType: 'text/plain',
		body: 'Attachment two — a non-ASCII filename, to exercise the RFC 5987 header.\n'
	},
	{
		slot: 'conv-3' as const,
		filename: 'unreachable.txt',
		contentType: 'text/plain',
		body: 'Hangs off the soft-deleted message; the download endpoint must 404.\n'
	}
];

const objectKey = (index: number) => `inbound/${STAMP}/file-${index}`;

/**
 * Contacts for the US-H01 compose autocomplete. All on one throwaway domain so
 * the cleanup can find them by address and can't touch a real correspondent.
 *
 * One with no name (an auto-created contact that only ever sent a bare address),
 * and two sharing a name fragment, so a demo can show both that the list
 * narrows and that an address-prefix match sorts ahead of a name match.
 */
const DEMO_CONTACTS = [
	{ email: `casey@${STAMP}.example`, name: 'Casey Demo' },
	{ email: `dana@${STAMP}.example`, name: 'Dana Casey' },
	{ email: `luca@${STAMP}.example`, name: null }
];

const cleanup = process.argv.includes('--cleanup');
// US-G01: soft-deletes every message in the seeded conversation, so the demo can
// show the "thread with no visible messages" 404 without hand-editing rows.
const hideConversation = process.argv.includes('--hide-conversation');

// Children before parents: the remote Turso connection enforces the FK.
async function removeSeededRows() {
	// Attachments first, and by their own key prefix rather than by a join: the
	// email rows they reference are about to go, and an orphaned attachment row
	// would block that delete.
	await db.delete(attachments).where(like(attachments.r2ObjectKey, `inbound/${STAMP}/%`));
	// Best-effort: a leftover object is invisible to the app (nothing references
	// it), so a failure here must not stop the row cleanup.
	await Promise.all(
		DEMO_FILES.map((_, index) =>
			r2
				.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(index) }))
				.catch((err) => console.error(`R2 cleanup failed for ${objectKey(index)}:`, err))
		)
	);
	await db.delete(emails).where(like(emails.messageId, `<${STAMP}%`));
	await db.delete(threads).where(like(threads.subject, `${STAMP}%`));
	await db.delete(authCodes).where(eq(authCodes.codeHash, hashAuthCode('123456')));
	// No FK points at `contacts`, so ordering doesn't matter here — but the
	// pattern must: only the seeded domain, never a real correspondent's row.
	await db.delete(contacts).where(like(contacts.email, `%@${STAMP}.example`));
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
			// HTML-only, to exercise the sandboxed-iframe rendering path (US-G02),
			// with one remote image (blocked until "Load images") and one `data:`
			// image (never blocked — the bytes are already here).
			bodyHtml:
				'<p>Second message, HTML only.</p><p>Second paragraph.</p>' +
				'<p><img src="https://example.com/tracker.gif" alt="remote pixel" width="120" height="40"></p>' +
				'<p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7" alt="inline dot" width="24" height="24"></p>' +
				// A link, to exercise the click interception: without it a click would
				// navigate the frame itself and render a remote page inside the app.
				'<p><a href="https://example.com/invoice">View invoice</a></p>',
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

	// US-G03: upload the demo objects, then one `attachments` row each. The email
	// ids are read back rather than captured from a `.returning()` above, so the
	// mapping is by `message_id` (the stable, human-readable key) instead of by
	// the position of a row in an insert's result.
	const conversationEmails = await db
		.select({ id: emails.id, messageId: emails.messageId })
		.from(emails)
		.where(like(emails.messageId, `<${STAMP}-conv%`));
	const emailIdBySlot = new Map(
		conversationEmails.map((row) => [
			row.messageId.replace(`<${STAMP}-`, '').replace('@invalid>', ''),
			row.id
		])
	);

	await Promise.all(
		DEMO_FILES.map((file, index) =>
			r2.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: objectKey(index),
					Body: Buffer.from(file.body, 'utf8'),
					ContentType: file.contentType
				})
			)
		)
	);

	await db.insert(attachments).values(
		DEMO_FILES.map((file, index) => ({
			emailId: emailIdBySlot.get(file.slot)!,
			filename: file.filename,
			contentType: file.contentType,
			sizeBytes: Buffer.byteLength(file.body, 'utf8'),
			r2ObjectKey: objectKey(index),
			// Fixed, ascending, so the rendered order is the same on every run —
			// `listAttachmentsForEmails` orders by `created_at`.
			createdAt: new Date(base + index * 1000)
		}))
	);

	// US-H01: the compose screen's recipient autocomplete reads `contacts`.
	await db.insert(contacts).values(
		DEMO_CONTACTS.map((contact, index) => ({
			...contact,
			autoCreated: true,
			createdAt: new Date(base + index * 1000),
			updatedAt: new Date(base + index * 1000)
		}))
	);

	await db.insert(authCodes).values({
		codeHash: hashAuthCode('123456'),
		expiresAt: new Date(Date.now() + 10 * 60_000)
	});

	console.log('seeded');
}

client.close();
