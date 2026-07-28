// The inbox subject/sender search (US-F04, tasks/prd-feature-inbox-list.md).
//
// Pure like `filter.ts` — no env, no db, no DOM — so the server load, the
// Svelte components and the standalone `tsx` verification script all agree on
// what a `?q=` value means.
import { withListParam } from './params';

/** The query-param name the search lives under (FR-3: `?filter=unread&q=…`). */
export const INBOX_SEARCH_PARAM = 'q';

/**
 * Longest query the list will run.
 *
 * The value reaches a `LIKE` pattern, so a caller could otherwise hand the
 * database an arbitrarily long string from a bookmarkable URL. Anything past
 * this is a mistake or an attack, not a search — and truncating rather than
 * erroring keeps a hand-edited URL from breaking the inbox, same reasoning as
 * `parseInboxFilter`'s fallback.
 */
export const MAX_INBOX_QUERY_LENGTH = 200;

/**
 * Narrows an untrusted `?q=` value to the query the list will actually run.
 *
 * Leading/trailing whitespace is dropped and internal runs collapsed, so
 * `"  invoice   #4 "` and `"invoice #4"` are the same search. An absent or
 * whitespace-only param normalizes to `''`, which every consumer reads as
 * "no search" — the empty string is the one value that must never reach the
 * query, or the list would filter on `%%` and look unfiltered while claiming
 * to be filtered.
 */
export function parseInboxQuery(value: string | null | undefined): string {
	return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_INBOX_QUERY_LENGTH);
}

/**
 * The `search` string for a link/submit that sets the query, preserving the
 * filter and any other param (FR-3). An empty query drops `?q=` entirely.
 */
export function inboxSearchSearch(current: URLSearchParams, query: string): string {
	return withListParam(current, INBOX_SEARCH_PARAM, parseInboxQuery(query));
}
