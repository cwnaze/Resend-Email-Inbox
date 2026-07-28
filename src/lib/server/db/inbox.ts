// The inbox list query (US-F01, tasks/prd-feature-inbox-list.md).
//
// Db-handle-first like `emails.ts` / `attachments.ts`, so this module never
// pulls in `$env/dynamic/private` and a standalone `tsx` script can drive it.
import { and, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { emails, threads } from './schema';
import type { Database } from './types';
// Relative, not `$lib/...`: this module is also loaded by the standalone
// `tsx` verification script, which has no Vite alias resolution.
import type { InboxFilter } from '../../inbox/filter';
import { parseInboxQuery } from '../../inbox/search';

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
 * The `LIKE` pattern for a case-insensitive substring search (US-F04).
 *
 * Lowercased here and compared against `lower(column)` rather than relying on
 * SQLite's `LIKE`, whose case-insensitivity is ASCII-only *and* switchable via
 * `PRAGMA case_sensitive_like`. `%`, `_` and the escape character itself are
 * escaped: without that, a query of `%` matches every thread and `_` matches
 * any character, so a user typing punctuation would get silently wrong results.
 * Every use of the returned pattern must carry the matching `escape '\'` clause.
 */
export function inboxSearchLikePattern(query: string): string {
	return `%${query.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The search predicate (US-F04, FR-2): the thread's subject, or any of its
 * visible emails' sender name/address.
 *
 * Runs in SQL, not as a post-filter in JS, because the list is capped at
 * `INBOX_PAGE_SIZE` — filtering after the limit would search one page rather
 * than the mailbox.
 *
 * `threads.subject` is the *normalized* subject (lowercased, `Re:`-stripped —
 * see the threading notes), which is why "invoice" finds "Re: Invoice #4". The
 * sender half is an `exists` subquery over the thread's non-deleted emails, so
 * a reply from someone the search names matches even when the thread's newest
 * message is from somebody else, and a soft-deleted email can't pull a thread
 * into the results with nothing on screen to explain the match.
 */
function inboxSearchCondition(query: string): SQL {
	const pattern = inboxSearchLikePattern(query);
	return or(
		sql`lower(${threads.subject}) like ${pattern} escape '\\'`,
		sql`exists (
			select 1 from ${emails} se
			where se.thread_id = ${threads.id}
				and se.is_deleted = 0
				and (
					lower(se.from_email) like ${pattern} escape '\\'
					or lower(coalesce(se.from_name, '')) like ${pattern} escape '\\'
				)
		)`
	)!;
}

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
 *
 * `filter` (US-F03) narrows to threads by read state. It filters on
 * `threads.is_read` — the thread-level flag, which per the Data Model PRD means
 * "every message in the thread is read" — rather than on the previewed email's
 * own `is_read`, so a thread with one unread message among several still counts
 * as unread here exactly as it does in the list's unread styling.
 *
 * `query` (US-F04) narrows to threads matching a subject/sender substring; it
 * combines with `filter` rather than replacing it (FR-3). It is run through
 * `parseInboxQuery` here as well as in the load, so a caller that forgets can't
 * hand this a whitespace-only string and get a `%%`-matches-everything search.
 */
export async function listInboxThreads(
	db: Database,
	options: { limit?: number; filter?: InboxFilter; query?: string } = {}
): Promise<InboxThreadRow[]> {
	const limit = options.limit ?? INBOX_PAGE_SIZE;
	const filter = options.filter ?? 'all';
	const query = parseInboxQuery(options.query);

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
		.where(
			and(
				filter === 'all' ? undefined : eq(threads.isRead, filter === 'read'),
				query === '' ? undefined : inboxSearchCondition(query)
			)
		)
		.orderBy(desc(threads.lastMessageAt), desc(threads.id))
		.limit(limit);

	return rows;
}
