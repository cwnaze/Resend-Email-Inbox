# Resend Email Inbox — Project Notes

## Stack

- SvelteKit (Svelte 5, runes mode forced via `vite.config.ts`'s `sveltekit({ compilerOptions: { runes: ... } })`), TypeScript, Tailwind CSS v4 (via `@tailwindcss/vite`, imported in `src/routes/layout.css` and pulled into `+layout.svelte`), `@sveltejs/adapter-vercel`.
- Package manager: npm. Scripts: `npm run dev`, `npm run build`, `npm run check` (typecheck via svelte-check), `npm run lint` (prettier --check + eslint), `npm run format`.

## Gotchas

- This SvelteKit toolchain (current `sv create` output) configures the Vite plugin and the adapter directly in `vite.config.ts` — there is **no `svelte.config.js`** in this project. If you need to change adapter options or compiler options, edit `vite.config.ts`.
- `@sveltejs/adapter-vercel`'s runtime auto-detection only supports Node 20/22/24. If the local dev machine runs a newer Node (e.g. v26), `npm run build` fails with `Unsupported Node.js version` unless the adapter is given an explicit runtime. This is already set: `adapter({ runtime: 'nodejs22.x' })` in `vite.config.ts`. Don't remove it.
- `.prettierignore` excludes `/tasks/`, `/agents/`, and `/docs/demos/` — those are PRD/agent-process files and showboat demo logs, not app source, and are intentionally left unformatted by the app's prettier config.
- `docs/demos/<STORY_ID>.md` files are showboat proof-of-work logs (one per user story). When capturing command output in a showboat `exec` block for later `showboat verify` reproducibility, strip anything non-deterministic (timestamps, build durations, PIDs) with `grep`/`sed` before showboat records the output — otherwise `showboat verify` will fail on a re-run even though nothing is actually broken.

## Database (Turso / Drizzle)

- `src/lib/server/db/index.ts` exports `db`, a `drizzle-orm/libsql` client built from `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` read via `$env/dynamic/private` (not `$env/static/private` — keeps the module importable even in contexts where those vars aren't statically inlined). Only import this from server-only code (`+page.server.ts`, `+server.ts`, `src/lib/server/**`).
- `src/lib/server/db/schema.ts` is the single Drizzle schema file; `drizzle.config.ts` (repo root, `dialect: 'turso'`) points at it and at `./drizzle` for generated migrations.
- Real Turso credentials live only in the gitignored root `.env` (never commit them); `.env.example` documents the variable names with empty values.
- `npm run db:push` applies the schema directly to the configured Turso database (no migration files); `npm run db:generate` emits SQL migration files under `./drizzle` if a versioned-migration workflow is needed later; `npm run db:studio` opens Drizzle Studio.
- Both `drizzle.config.ts` and `src/lib/server/db/index.ts` throw at startup if either `TURSO_DATABASE_URL` or `TURSO_AUTH_TOKEN` is missing — a remote Turso connection needs both, so failing fast on either avoids a confusing runtime error from `@libsql/client` later.
- If a future story switches to `npm run db:generate` (versioned migrations instead of `db:push`), commit the generated `./drizzle/*.sql` files and the `./drizzle/meta` journal — they're a source-of-truth migration history, not disposable build output, so `./drizzle` should NOT be gitignored once it's in use.

## Object storage (Cloudflare R2)

- `src/lib/server/r2/index.ts` exports three server-only utilities: `uploadToR2(key, body, contentType?)`, `deleteFromR2(key)`, and `getR2SignedDownloadUrl(key, expiresInSeconds?)` (default 15 min). Built on `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` against R2's S3-compatible API at `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.
- The bucket is **private** — there is no `R2_PUBLIC_URL_BASE`/static public URL. Any place the app needs to let the browser fetch/download an object must call `getR2SignedDownloadUrl` on demand rather than storing a permanent URL. This affects the `attachments` table (stores `r2_object_key`, not a public URL) and any UI that lists/downloads attachments.
- Required env vars: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (read via `$env/dynamic/private`, same pattern as the Turso vars). The module throws at import time if any are missing.
- Only import `src/lib/server/r2` from server-only code (`+page.server.ts`, `+server.ts`, `src/lib/server/**`) — same rule as the `db` client.

## Auth (session cookie)

- `src/lib/server/auth/session.ts` exports `SESSION_COOKIE_NAME` — the single shared constant for the session cookie's name. Any code that reads, sets, or clears the session cookie should import this rather than repeating the string literal (auth-code verification sets it, the `(app)` layout checks it, logout clears it).
- `src/routes/(app)/+layout.server.ts` currently only checks that the session cookie is _present_ (`redirect(303, '/login')` if absent) — it does not yet look up a `sessions` DB row. Full expiry/validity checking against the `sessions` table is a separate, later story's concern; don't assume this layout already rejects a forged/expired cookie.

## Workflow

- This repo follows the Ralph per-story branch + PR workflow described in `agents/ralph.md`, driven by `agents/prd.json`. One story per branch/PR, human merges.
- When capturing `curl -i` output in a `showboat exec` block, strip the `\r` from HTTP header lines (e.g. `tr -d '\r'`) in the exact command that gets recorded — otherwise `showboat verify` reports a mismatch (expected vs. re-run actual) even though both look textually identical in a terminal; the difference is invisible `\r` bytes only visible via `od -c`.
- `showboat pop` removes only the single most recent entry. If several blocks were exec'd in a row and an earlier one needs fixing, it's simpler to hand-edit the demo `.md` file directly (just don't touch the `showboat-id` HTML comment) than to chain multiple `pop`s.
