// CORS allowlist for the public contact endpoint.
//
// This is the only route in the app a *different* origin is allowed to call, so
// the allowlist lives here rather than anywhere global — nothing else should
// inherit it. Origins come from `CONTACT_ALLOWED_ORIGINS` (comma-separated) so
// the site's domain can change without a deploy of this repo; the defaults cover
// the portfolio site and local development.
import { env } from '$env/dynamic/private';

const DEFAULT_ORIGINS = [
	'https://caseynazelrod.com',
	'https://www.caseynazelrod.com',
	'http://localhost:5173',
	'http://localhost:4173'
];

function allowedOrigins(): string[] {
	const configured = (env.CONTACT_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((origin) => origin.trim().replace(/\/$/, ''))
		.filter(Boolean);

	return configured.length > 0 ? configured : DEFAULT_ORIGINS;
}

/**
 * Echoes back the request's `Origin` when it is allowed.
 *
 * Echoing rather than sending a wildcard is what keeps the allowlist meaningful:
 * `*` would let any page on the internet POST here. A disallowed (or absent)
 * origin gets no CORS headers at all — the request may still reach the handler
 * (a non-browser client has no origin to send), but a browser on an unlisted
 * site cannot read the response, and the endpoint's own rate limit is what
 * bounds the rest.
 */
export function corsHeaders(origin: string | null): Record<string, string> {
	if (!origin || !allowedOrigins().includes(origin.replace(/\/$/, ''))) return {};

	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
		// The response body varies by origin, so a shared cache must not serve one
		// site's CORS headers to another.
		Vary: 'Origin'
	};
}
