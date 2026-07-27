// Drizzle query helpers for the `contacts` table (US-E02).
//
// Same shape as `src/lib/server/auth/*.ts`: the db handle is the first
// argument (typed via `Database` from `./types`) rather than importing the `db`
// singleton, so this module never pulls in `$env/dynamic/private` and can be
// exercised by a standalone `tsx` verification script.
import { eq, sql } from 'drizzle-orm';
import { contacts } from './schema';
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

export type UpsertContactResult = {
	contact: Contact;
	/** True when this call inserted the row (vs. finding an existing one). */
	created: boolean;
	/** True when this call overwrote an auto-created contact's name. */
	nameUpdated: boolean;
};

/**
 * Upserts the sender of an inbound email into `contacts`.
 *
 * New addresses are inserted with `auto_created = true` and the payload's
 * display name. An existing contact with `auto_created = false` has been
 * **manually edited by the owner** (US-I02), so its name is never overwritten —
 * that's the whole point of the flag. An existing auto-created contact does get
 * its name refreshed, since a later delivery carrying a display name is strictly
 * better than the null a first, bare-address delivery left behind.
 */
export async function upsertContactFromInbound(
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
