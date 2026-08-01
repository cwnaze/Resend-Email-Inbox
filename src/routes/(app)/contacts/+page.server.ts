// Contacts list load (US-I01).
//
// Auth is already guaranteed by `(app)/+layout.server.ts` — the session choke
// point for page *renders* — and this load only reads, so there is deliberately
// no second session check. A mutating action added here (US-I02/US-I03) must
// call `validateSession` itself; see `docs/notes/auth.md`.
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { listContacts } from '$lib/server/db/contacts';

export const load: PageServerLoad = async () => {
	const rows = await listContacts(db);

	// `displayName` is resolved here rather than in the component because it is
	// also what the query sorted by — deriving it twice is how the heading and
	// the ordering drift apart. The timestamp stays a `Date` (SvelteKit
	// serializes it as one) so the row can render both a relative label and a
	// machine-readable `datetime`, same as `ThreadRow`.
	return {
		contacts: rows.map((row) => ({
			id: row.id,
			displayName: row.name?.trim() || row.email,
			email: row.email,
			messageCount: row.messageCount,
			lastContactedAt: row.lastContactedAt
		}))
	};
};
