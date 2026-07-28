// The inbox read/unread filter (US-F03, tasks/prd-feature-inbox-list.md).
//
// Pure like `format.ts` — no env, no db, no DOM — so the server load, the
// Svelte components and a standalone `tsx` script all read the same definition
// of what a valid filter value is.

/** The filter values the control offers, in the order it renders them. */
export const INBOX_FILTERS = ['all', 'unread', 'read'] as const;

export type InboxFilter = (typeof INBOX_FILTERS)[number];

/** The query-param name the filter lives under (FR-3: `?filter=unread&q=…`). */
export const INBOX_FILTER_PARAM = 'filter';

export const DEFAULT_INBOX_FILTER: InboxFilter = 'all';

/**
 * Narrows an untrusted `?filter=` value to an `InboxFilter`.
 *
 * Anything unrecognised — a missing param, a typo, a hand-edited URL — falls
 * back to `all` rather than erroring: the filter is a view preference, and a
 * 400 on a bad query string would turn a stale bookmark into a broken inbox.
 */
export function parseInboxFilter(value: string | null | undefined): InboxFilter {
	return INBOX_FILTERS.includes(value as InboxFilter)
		? (value as InboxFilter)
		: DEFAULT_INBOX_FILTER;
}

/** The label the filter control shows for each value. */
export function inboxFilterLabel(filter: InboxFilter): string {
	switch (filter) {
		case 'unread':
			return 'Unread';
		case 'read':
			return 'Read';
		default:
			return 'All';
	}
}

/**
 * The `search` string for a filter link, preserving every other param.
 *
 * FR-3 requires filter and search state to be representable together, so the
 * control must not rebuild the query string from scratch — US-F04's `?q=` has
 * to survive a filter change. `all` drops the param entirely rather than
 * writing `?filter=all`, keeping the default view's URL clean.
 */
export function inboxFilterSearch(current: URLSearchParams, filter: InboxFilter): string {
	const params = new URLSearchParams(current);
	if (filter === DEFAULT_INBOX_FILTER) {
		params.delete(INBOX_FILTER_PARAM);
	} else {
		params.set(INBOX_FILTER_PARAM, filter);
	}
	const search = params.toString();
	return search === '' ? '' : `?${search}`;
}
