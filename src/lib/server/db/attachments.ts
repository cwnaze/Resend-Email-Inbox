// Drizzle query helpers for the `attachments` table (US-E05).
//
// Db-handle-first like `emails.ts` / `contacts.ts`, so this module never pulls
// in `$env/dynamic/private` and a standalone `tsx` script can drive it.
import { asc, eq } from 'drizzle-orm';
import { attachments } from './schema';
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

export async function getAttachmentsByEmailId(
	db: Database,
	emailId: string
): Promise<Attachment[]> {
	return db
		.select()
		.from(attachments)
		.where(eq(attachments.emailId, emailId))
		.orderBy(asc(attachments.createdAt));
}
