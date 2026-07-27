// Drizzle query helpers for the `emails` and `threads` tables (US-E03).
//
// Same shape as `contacts.ts` / `src/lib/server/auth/*.ts`: the db handle is the
// first argument (typed via `Database` from `./types`) rather than importing the
// `db` singleton, so this module never pulls in `$env/dynamic/private` and can
// be exercised by a standalone `tsx` verification script.
import { eq } from 'drizzle-orm';
import { emails, threads } from './schema';
import type { Database } from './types';

export type Email = typeof emails.$inferSelect;
export type Thread = typeof threads.$inferSelect;

export type NewInboundEmail = {
	threadId: string;
	messageId: string;
	inReplyTo: string | null;
	fromEmail: string;
	fromName: string | null;
	toEmails: string[];
	ccEmails: string[];
	bccEmails: string[];
	subject: string;
	bodyText: string | null;
	/** Must already be sanitized — see `inbound/sanitize.ts`. */
	bodyHtml: string | null;
	receivedAt: Date;
};

export async function getEmailByMessageId(
	db: Database,
	messageId: string
): Promise<Email | undefined> {
	const [row] = await db.select().from(emails).where(eq(emails.messageId, messageId)).limit(1);
	return row;
}

export type InsertInboundEmailResult = {
	email: Email;
	/** False when this exact `message_id` was already stored (a redelivery). */
	created: boolean;
};

/**
 * Inserts an inbound email, idempotently on `message_id` (FR-2).
 *
 * `onConflictDoNothing()` + a re-read on the empty result is the same pattern
 * `upsertContactFromInbound` uses, and for the same reason: Resend retries
 * webhook deliveries, so a duplicate is an expected event, not an error. A bare
 * insert would turn the `emails_message_id_unique` violation into a 500 — which
 * Resend would then retry forever, against a row that is already stored.
 */
export async function insertInboundEmail(
	db: Database,
	values: NewInboundEmail
): Promise<InsertInboundEmailResult> {
	const [inserted] = await db
		.insert(emails)
		.values({ ...values, direction: 'inbound', isRead: false, isDeleted: false })
		.onConflictDoNothing()
		.returning();

	if (inserted) return { email: inserted, created: true };

	const existing = await getEmailByMessageId(db, values.messageId);
	if (existing) return { email: existing, created: false };

	throw new Error(`inbound email insert failed for message_id ${values.messageId}`);
}

/**
 * Creates a thread. US-E04 replaces the *choice* of thread (In-Reply-To /
 * subject matching) but not this helper — a genuinely new conversation still
 * lands here.
 */
export async function createThread(
	db: Database,
	values: { subject: string; lastMessageAt: Date }
): Promise<Thread> {
	const [thread] = await db
		.insert(threads)
		.values({ subject: values.subject, lastMessageAt: values.lastMessageAt, isRead: false })
		.returning();
	return thread;
}

/** Removes a thread row. Used to clean up a thread whose email lost an insert race. */
export async function deleteThread(db: Database, threadId: string): Promise<void> {
	await db.delete(threads).where(eq(threads.id, threadId));
}
