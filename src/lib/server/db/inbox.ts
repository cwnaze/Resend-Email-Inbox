// The inbox list query (US-F01, tasks/prd-feature-inbox-list.md).
//
// Db-handle-first like `emails.ts` / `attachments.ts`, so this module never
// pulls in `$env/dynamic/private` and a standalone `tsx` script can drive it.
import { desc, eq, sql } from 'drizzle-orm';
import { emails, threads } from './schema';
import type { Database } from './types';

export type InboxThreadRow = {
	threadId: string;
	/** Normalized (lowercased, `Re:`-stripped) — see the threading notes. */
	threadSubject: string;
	lastMessageAt: Date;
	isRead: boolean;
	latestEmailId: string;
	/** The latest email's own subject, i.e. the sender's original wording. */
	subject: string;
	fromEmail: string;
	fromName: string | null;
	bodyText: string | null;
	bodyHtml: string | null;
	receivedAt: Date;
	/** Non-deleted emails in the thread. */
	messageCount: number;
};

/** FR-1's "reasonable page size" (Non-Goals: no real pagination in v1). */
export const INBOX_PAGE_SIZE = 50;

/**
 * Threads for the inbox list, newest activity first, one row per thread.
 *
 * Deliberately **one** query (FR-1): the preview columns come from a correlated
 * subquery picking each thread's latest non-deleted email, not from a second
 * round trip per row. `emails_thread_id_idx` covers that lookup.
 *
 * That join is an INNER join on purpose — it is also what implements the
 * soft-delete rule. A thread whose every member email has `is_deleted = 1` has
 * no row to join to and therefore drops out of the list entirely, without a
 * separate `NOT EXISTS` clause that could drift away from the preview's own
 * definition of "visible email".
 */
export async function listInboxThreads(
	db: Database,
	options: { limit?: number } = {}
): Promise<InboxThreadRow[]> {
	const limit = options.limit ?? INBOX_PAGE_SIZE;

	// `received_at` is the sort key, with `id` as a deterministic tie-breaker so
	// two emails carrying the identical header timestamp can't make the preview
	// flip between page loads.
	const latestVisibleEmailId = sql<string>`(
		select le.id from ${emails} le
		where le.thread_id = ${threads.id} and le.is_deleted = 0
		order by le.received_at desc, le.id desc
		limit 1
	)`;

	const rows = await db
		.select({
			threadId: threads.id,
			threadSubject: threads.subject,
			lastMessageAt: threads.lastMessageAt,
			isRead: threads.isRead,
			latestEmailId: emails.id,
			subject: emails.subject,
			fromEmail: emails.fromEmail,
			fromName: emails.fromName,
			bodyText: emails.bodyText,
			bodyHtml: emails.bodyHtml,
			receivedAt: emails.receivedAt,
			messageCount: sql<number>`(
				select count(*) from ${emails} ce
				where ce.thread_id = ${threads.id} and ce.is_deleted = 0
			)`
		})
		.from(threads)
		.innerJoin(emails, eq(emails.id, latestVisibleEmailId))
		.orderBy(desc(threads.lastMessageAt), desc(threads.id))
		.limit(limit);

	return rows;
}
