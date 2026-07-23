// Shared session-cookie constant used by every story that touches auth:
// - US-A03 (this story) only checks whether the cookie is *present* to gate
//   the (app) route group before the sessions table/verify-code flow exist.
// - US-B03 (verify-code) will be the first to actually *set* this cookie
//   (httpOnly, Secure, SameSite=Lax) after creating a `sessions` row.
// - US-B05 (route protection/logout) will upgrade the (app) layout check
//   below from "cookie present" to "cookie matches a non-expired sessions
//   row", and will clear this same cookie name on logout.
//
// Centralizing the name here (rather than repeating the string literal in
// every route file) keeps all of those stories in sync.
export const SESSION_COOKIE_NAME = 'session';
