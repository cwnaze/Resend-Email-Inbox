// Inbox list load (US-F01).
//
// Auth is already guaranteed by `(app)/+layout.server.ts` — the single session
// choke point for this route group — so there is deliberately no second session
// check here.
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { listInboxThreads } from '$lib/server/db/inbox';
import { bodySnippet, senderLabel } from '$lib/inbox/format';

export const load: PageServerLoad = async () => {
	const rows = await listInboxThreads(db);

	// The snippet is derived server-side so the (potentially large) HTML body
	// never has to cross the wire just to render one preview line.
	return {
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
