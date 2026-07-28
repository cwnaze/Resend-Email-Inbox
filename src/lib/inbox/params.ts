// Query-string plumbing shared by every inbox list-state param (US-F04).
//
// Pure like `format.ts` / `filter.ts` — no env, no db, no DOM.
//
// FR-3 requires the filter and the search query to be representable in the URL
// *at the same time*, which means no control may rebuild the query string from
// scratch: each one has to edit its own param and leave the rest alone. Both
// `inboxFilterSearch` and `inboxSearchSearch` are thin wrappers over this
// function, so a third list-state param gets that property for free — write it
// here rather than assembling `?a=…&b=…` at a call site.

/**
 * The `search` string for a link that sets `param` to `value`, preserving every
 * other param in `current`.
 *
 * A `null` value (or one that is the param's default) **deletes** the param
 * instead of writing an empty one, keeping the default view's URL clean.
 */
export function withListParam(
	current: URLSearchParams,
	param: string,
	value: string | null
): string {
	const params = new URLSearchParams(current);
	if (value === null || value === '') {
		params.delete(param);
	} else {
		params.set(param, value);
	}
	const search = params.toString();
	return search === '' ? '' : `?${search}`;
}
