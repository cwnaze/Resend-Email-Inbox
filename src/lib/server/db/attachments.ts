// Drizzle query helpers for the `attachments` table (US-E05).
//
// Db-handle-first like `emails.ts` / `contacts.ts`, so this module never pulls
// in `$env/dynamic/private` and a standalone `tsx` script can drive it.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { attachments, emails } from './schema';
import type { Database } from './types';

export type Attachment = typeof attachments.$inferSelect;

export type NewAttachment = {
	emailId: string;
	filename: string;
	contentType: string;
	sizeBytes: number;
	/** R2 object key — never a URL. The bucket is private (see `server/r2`). */
	r2ObjectKey: string;
};

export async function insertAttachment(db: Database, values: NewAttachment): Promise<Attachment> {
	const [row] = await db.insert(attachments).values(values).returning();
	return row;
}

/**
 * One email's attachments. Delegates to `listAttachmentsForEmails` so the two
 * cannot drift apart on ordering — this one used to order by `createdAt` alone,
 * which left a same-millisecond pair free to swap between calls.
 */
export async function getAttachmentsByEmailId(
	db: Database,
	emailId: string
): Promise<Attachment[]> {
	return listAttachmentsForEmails(db, [emailId]);
}

/**
 * Every attachment belonging to any of `emailIds`, in one query (US-G03).
 *
 * The thread view needs the attachments of every message it renders, and
 * calling `getAttachmentsByEmailId` per message would issue one round trip per
 * message against a remote Turso database — the same reason `listInboxThreads`
 * is a single query rather than a per-row lookup. The caller groups by
 * `emailId`.
 *
 * `createdAt` then `id` orders each email's files: attachments are inserted
 * sequentially in the order the sender's email listed them, so `createdAt` is
 * that order, and `id` breaks the tie when two inserts land in the same
 * millisecond (which is normal for small files) so a message's attachment list
 * cannot reorder itself between loads.
 */
export async function listAttachmentsForEmails(
	db: Database,
	emailIds: string[]
): Promise<Attachment[]> {
	// `inArray` with an empty list is a SQL error in some dialects and a
	// pointless round trip in all of them.
	if (emailIds.length === 0) return [];

	return db
		.select()
		.from(attachments)
		.where(inArray(attachments.emailId, emailIds))
		.orderBy(asc(attachments.createdAt), asc(attachments.id));
}

export type ThreadAttachment = {
	id: string;
	filename: string;
	contentType: string;
	sizeBytes: number;
	r2ObjectKey: string;
};

/**
 * Looks up one attachment *scoped to a thread*, for the download endpoint
 * (US-G03).
 *
 * The thread id is part of the lookup rather than checked afterwards, and the
 * join carries `emails.is_deleted = false`, so the endpoint cannot hand out an
 * object the thread view would refuse to show: a soft-deleted message's files
 * stop being reachable at the same moment the message does, using the same
 * definition of "visible email" as `listThreadEmails` and `listInboxThreads`.
 * A mismatched thread id and a nonexistent attachment id are one outcome
 * (`undefined`) on purpose — the endpoint answers 404 either way, so a probe
 * cannot tell "wrong thread" from "no such file".
 */
export async function getThreadAttachment(
	db: Database,
	threadId: string,
	attachmentId: string
): Promise<ThreadAttachment | undefined> {
	const [row] = await db
		.select({
			id: attachments.id,
			filename: attachments.filename,
			contentType: attachments.contentType,
			sizeBytes: attachments.sizeBytes,
			r2ObjectKey: attachments.r2ObjectKey
		})
		.from(attachments)
		.innerJoin(emails, eq(attachments.emailId, emails.id))
		.where(
			and(
				eq(attachments.id, attachmentId),
				eq(emails.threadId, threadId),
				eq(emails.isDeleted, false)
			)
		)
		.limit(1);
	return row;
}
