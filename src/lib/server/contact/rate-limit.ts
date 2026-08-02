// Best-effort rate limit for the public contact endpoint.
//
// In-memory and therefore per-instance: on a serverless platform a determined
// flood spread across cold starts will get more through than the nominal limit.
// That is understood and accepted — this exists to stop a single script hammering
// one warm instance from filling the inbox, not to be an authoritative quota. The
// hard bounds on what a submission can *cost* (field length caps in
// `submission.ts`) are what keep the damage small either way.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;

const hits = new Map<string, number[]>();

/**
 * Records an attempt for `key` and reports whether it is within the limit.
 *
 * Expired timestamps are dropped on every call for the key being checked, and
 * emptied keys are deleted, so the map cannot grow without bound from one-off
 * addresses.
 */
export function allowSubmission(key: string, now: number = Date.now()): boolean {
	const cutoff = now - WINDOW_MS;
	const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);

	if (recent.length >= MAX_PER_WINDOW) {
		hits.set(key, recent);
		return false;
	}

	recent.push(now);
	hits.set(key, recent);

	// Opportunistic sweep of other keys: without it, an instance that has been warm
	// for days holds an entry per address that ever submitted.
	if (hits.size > 1000) {
		for (const [other, timestamps] of hits) {
			const live = timestamps.filter((at) => at > cutoff);
			if (live.length === 0) hits.delete(other);
			else hits.set(other, live);
		}
	}

	return true;
}
