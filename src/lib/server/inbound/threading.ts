// Subject normalization for thread grouping (US-E04).
//
// Pure by design — no env, no db, no network — same rule as `parse.ts`, so the
// fixture-driven `verify-inbound-parse.mts` script can exercise it directly.
//
// `threads.subject` stores the *normalized* subject (Data Model PRD: "normalized
// subject (e.g., 'Re:' stripped for grouping)"), so the subject fallback in
// FR-4 can compare stored-normalized against incoming-normalized without a
// second normalization pass over the table at query time. The per-email
// `emails.subject` keeps the sender's original wording.

/**
 * Reply/forward prefixes, in the localized forms worth handling. Matched
 * case-insensitively, with an optional bracketed counter (`Re[2]:`, `Re(2):`)
 * that some clients add.
 */
const REPLY_PREFIX = /^\s*(?:re|aw|sv|vs|fwd?|tr|wg|rv|enc)\s*(?:[[(]\d+[\])])?\s*:\s*/i;

/**
 * Strips reply/forward prefixes and collapses whitespace.
 *
 * The prefixes are stripped in a loop, not once: `Re: Fwd: Re: foo` is a single
 * conversation and every hop adds another one. Case and whitespace are
 * normalized too, because `threads_subject`-based grouping is a plain string
 * comparison in SQLite and `RE:  Foo ` must not start a second thread from
 * `Re: Foo`.
 *
 * An empty or whitespace-only subject normalizes to `''`. Callers must treat
 * that as *unthreadable* rather than as a group key — every subject-less email
 * in the mailbox would otherwise collapse into one thread.
 */
export function normalizeSubject(subject: string): string {
	let value = subject.replace(/\s+/g, ' ').trim();

	// Bound the loop: a pathological subject of nothing but prefixes shouldn't
	// spin, and no real conversation is 20 hops of `Re:` deep.
	for (let i = 0; i < 20; i++) {
		const stripped = value.replace(REPLY_PREFIX, '');
		if (stripped === value) break;
		value = stripped.trim();
	}

	return value.toLowerCase();
}

/** Window for the FR-4 subject fallback: same normalized subject within 30 days. */
export const SUBJECT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
