// Drizzle query helpers for the `contacts` table (US-E02).
//
// Same shape as `src/lib/server/auth/*.ts`: the db handle is the first
// argument (typed via `Database` from `./types`) rather than importing the `db`
// singleton, so this module never pulls in `$env/dynamic/private` and can be
// exercised by a standalone `tsx` verification script.
import { eq, sql } from 'drizzle-orm';
import { contacts, emails } from './schema';
import type { Database } from './types';

export type Contact = typeof contacts.$inferSelect;

/**
 * Email addresses are matched and stored case-insensitively (FR: "upserted by
 * email (case-insensitive)"). Normalizing on write is what makes the
 * `contacts_email_unique` index — a plain, case-sensitive SQLite unique index —
 * actually enforce one row per address; reads still compare with `lower()` so
 * any row written before this normalization existed is still found.
 */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export async function getContactByEmail(db: Database, email: string): Promise<Contact | undefined> {
	const [row] = await db
		.select()
		.from(contacts)
		.where(sql`lower(${contacts.email}) = ${normalizeEmail(email)}`)
		.limit(1);
	return row;
}

/**
 * Every contact, for the compose screen's recipient autocomplete (US-H01).
 *
 * The whole table, filtered in the browser rather than per keystroke on the
 * server: Turso is remote, so a query per keystroke is a round trip per
 * keystroke, and this table holds one row per address the owner has ever
 * corresponded with — kilobytes, not megabytes. If it ever grows past what a
 * page load should carry, the fix is a server-side `?q=` lookup, not a bigger
 * payload.
 *
 * Only the two columns the suggestion list renders are selected, so
 * `auto_created` and the timestamps don't cross the wire. Ordering is name-then-
 * address so it's stable and the list reads alphabetically; `suggestContacts`
 * preserves this order within a rank.
 */
export async function listContactsForSuggestions(
	db: Database
): Promise<{ email: string; name: string | null }[]> {
	return db
		.select({ email: contacts.email, name: contacts.name })
		.from(contacts)
		.orderBy(sql`coalesce(${contacts.name}, ${contacts.email}) collate nocase`, contacts.email);
}

export type ContactListRow = {
	id: string;
	email: string;
	name: string | null;
	autoCreated: boolean;
	/** Messages exchanged with this address, excluding soft-deleted ones. */
	messageCount: number;
	/** `received_at` of the most recent such message, or `null` for none. */
	lastContactedAt: Date | null;
};

/**
 * One line of SQL deciding whether an `emails` row counts as correspondence
 * with a given contact: the contact either sent it or was addressed on it.
 *
 * `emails` stores addresses as plain text/JSON independent of `contacts` (see
 * the contacts PRD's open question — a deleted contact must not rewrite
 * history), so the link is by address, not by foreign key. `to_emails`/
 * `cc_emails` are JSON arrays, hence `json_each`; `cc_emails` is nullable, so
 * it needs the `coalesce` or `json_each` errors on a NULL argument. Comparison
 * is `lower()`-ed on both sides for the same reason `getContactByEmail` is: the
 * addresses in `emails` were never case-normalized.
 *
 * `bcc_emails` is deliberately not searched — a Bcc recipient is not part of
 * the visible correspondence on the thread, and outbound sends record the same
 * addresses in `to`/`cc` anyway when they are real correspondents.
 */
const CORRESPONDS_WITH_CONTACT = sql`
	${emails.isDeleted} = 0
	and (
		lower(${emails.fromEmail}) = lower(${contacts.email})
		or exists (
			select 1 from json_each(${emails.toEmails}) as recipient
			where lower(recipient.value) = lower(${contacts.email})
		)
		or exists (
			select 1 from json_each(coalesce(${emails.ccEmails}, '[]')) as recipient
			where lower(recipient.value) = lower(${contacts.email})
		)
	)
`;

/**
 * Every contact with its correspondence stats, for `/contacts` (US-I01).
 *
 * One query, not one-per-row: the message count and the last-contacted stamp
 * come from a single LEFT JOIN + GROUP BY over `emails`, so a contact with no
 * surviving messages still renders (count 0, no timestamp) instead of dropping
 * out of the list — the opposite of the inbox list's INNER join, where a thread
 * with no visible message genuinely has nothing to show.
 *
 * Ordered alphabetically by display name falling back to the address, matching
 * `listContactsForSuggestions` so the two views agree.
 */
export async function listContacts(db: Database): Promise<ContactListRow[]> {
	const rows = await db
		.select({
			id: contacts.id,
			email: contacts.email,
			name: contacts.name,
			autoCreated: contacts.autoCreated,
			// Counting `emails.id` (not `*`) is what makes the LEFT JOIN's
			// no-match row count as 0 rather than 1.
			messageCount: sql<number>`count(${emails.id})`,
			// Selected through `sql` rather than the column, so Drizzle's
			// `timestamp_ms` mode does not apply — this comes back as a raw
			// number of milliseconds (or null) and is wrapped below.
			lastContactedAt: sql<number | null>`max(${emails.receivedAt})`
		})
		.from(contacts)
		.leftJoin(emails, CORRESPONDS_WITH_CONTACT)
		.groupBy(contacts.id)
		.orderBy(sql`coalesce(${contacts.name}, ${contacts.email}) collate nocase`, contacts.email);

	return rows.map((row) => ({
		...row,
		messageCount: Number(row.messageCount),
		lastContactedAt: row.lastContactedAt == null ? null : new Date(Number(row.lastContactedAt))
	}));
}

/**
 * Longest display name a manual edit may store (US-I02).
 *
 * `contacts.name` is an unbounded SQLite `text` column, and the contacts list
 * and compose autocomplete both render the name in a single truncated line —
 * so the cap is about keeping a pasted essay out of the table, not about the
 * storage. Exported because the edit form's `maxlength` and the action's own
 * check have to be the same number.
 */
export const MAX_CONTACT_NAME_LENGTH = 200;

/**
 * Renames a contact by hand and takes it out of auto-derivation (US-I02, FR-2).
 *
 * The two writes are one statement on purpose: `auto_created = false` is not a
 * separate feature of this action, it *is* the edit's durability. The flag is
 * the only thing standing between the owner's chosen name and the next inbound
 * delivery from that address, which `upsertAutoContact` would otherwise use to
 * overwrite it. Setting the name without clearing the flag would look like it
 * worked and silently revert on the next email.
 *
 * A blank name stores `null` rather than `''` — that is the value the list's
 * sort and `displayName` already treat as "fall back to the address", and an
 * empty string would sort ahead of every real name. Clearing still clears the
 * flag: choosing to show the bare address is as much an owner decision as
 * choosing a name, and it must survive the next delivery too.
 *
 * Returns the updated row, or `undefined` for an id that no longer exists —
 * the caller decides what a missing contact means (this one 404s).
 */
export async function updateContactName(
	db: Database,
	id: string,
	name: string | null,
	now: Date = new Date()
): Promise<Contact | undefined> {
	const [updated] = await db
		.update(contacts)
		.set({ name: name?.trim() || null, autoCreated: false, updatedAt: now })
		.where(eq(contacts.id, id))
		.returning();
	return updated;
}

export type UpsertContactResult = {
	contact: Contact;
	/** True when this call inserted the row (vs. finding an existing one). */
	created: boolean;
	/** True when this call overwrote an auto-created contact's name. */
	nameUpdated: boolean;
};

/**
 * Upserts an address this app has seen into `contacts`, `auto_created`.
 *
 * Two callers, both of them "the owner corresponded with this address": the
 * inbound webhook, with the sender of an arriving email and its display name
 * (US-E02), and the send path, with every To/Cc recipient of a message the owner
 * sent (US-H02, FR-5) — nameless, because compose drops display names.
 *
 * New addresses are inserted with `auto_created = true` and the payload's
 * display name. An existing contact with `auto_created = false` has been
 * **manually edited by the owner** (US-I02), so its name is never overwritten —
 * that's the whole point of the flag. An existing auto-created contact does get
 * its name refreshed, since a later delivery carrying a display name is strictly
 * better than the null a first, bare-address delivery left behind.
 */
export async function upsertAutoContact(
	db: Database,
	sender: { email: string; name?: string | null },
	now: Date = new Date()
): Promise<UpsertContactResult> {
	const email = normalizeEmail(sender.email);
	const name = sender.name?.trim() || null;

	const existing = await getContactByEmail(db, email);

	if (!existing) {
		// `onConflictDoNothing` + re-read rather than a bare insert: two inbound
		// deliveries from the same new sender can be in flight at once (Resend
		// retries, and a serverless runtime happily runs both), and losing that
		// race should be a no-op, not a 500 that makes Resend retry forever.
		const [inserted] = await db
			.insert(contacts)
			.values({ email, name, autoCreated: true, createdAt: now, updatedAt: now })
			.onConflictDoNothing()
			.returning();

		if (inserted) {
			return { contact: inserted, created: true, nameUpdated: false };
		}

		const raced = await getContactByEmail(db, email);
		if (raced) {
			return { contact: raced, created: false, nameUpdated: false };
		}
		throw new Error(`contact upsert failed for ${email}`);
	}

	if (!existing.autoCreated || !name || name === existing.name) {
		return { contact: existing, created: false, nameUpdated: false };
	}

	const [updated] = await db
		.update(contacts)
		.set({ name, updatedAt: now })
		.where(eq(contacts.id, existing.id))
		.returning();

	return { contact: updated ?? existing, created: false, nameUpdated: true };
}
