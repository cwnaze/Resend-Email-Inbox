// Inbox list load (US-F01).
//
// Auth is already guaranteed by `(app)/+layout.server.ts` — the single session
// choke point for this route group — so there is deliberately no second session
// check here.
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { listInboxThreads } from '$lib/server/db/inbox';
import { bodySnippet, senderLabel } from '$lib/inbox/format';
import { INBOX_FILTER_PARAM, parseInboxFilter } from '$lib/inbox/filter';
import { INBOX_SEARCH_PARAM, parseInboxQuery } from '$lib/inbox/search';

export const load: PageServerLoad = async ({ url }) => {
	// The URL is the single source of truth for the filter (US-F03) and the
	// search query (US-F04), so a refresh, a back-navigation and a shared link
	// all reproduce the same view. Both narrow the query server-side (FR-2) —
	// never by hiding rows the client already received.
	const filter = parseInboxFilter(url.searchParams.get(INBOX_FILTER_PARAM));
	const query = parseInboxQuery(url.searchParams.get(INBOX_SEARCH_PARAM));
	const rows = await listInboxThreads(db, { filter, query });

	// The snippet is derived server-side so the (potentially large) HTML body
	// never has to cross the wire just to render one preview line.
	return {
		filter,
		query,
		threads: rows.map((row) => ({
			id: row.threadId,
			subject: row.subject,
			sender: senderLabel(row.fromName, row.fromEmail),
			senderEmail: row.fromEmail,
			snippet: bodySnippet(row.bodyText, row.bodyHtml),
			messageCount: row.messageCount,
			isRead: row.isRead,
			lastMessageAt: row.lastMessageAt
		}))
	};
};
