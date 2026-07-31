# Resend Email Inbox — Project Notes

## Stack

- SvelteKit (Svelte 5, runes mode forced via `vite.config.ts`'s `sveltekit({ compilerOptions: { runes: ... } })`), TypeScript, Tailwind CSS v4 (via `@tailwindcss/vite`, imported in `src/routes/layout.css` and pulled into `+layout.svelte`), `@sveltejs/adapter-vercel`.
- Package manager: npm. Scripts: `npm run dev`, `npm run build`, `npm run check` (typecheck via svelte-check), `npm run lint` (prettier --check + eslint), `npm run format`.

## Gotchas

- This SvelteKit toolchain (current `sv create` output) configures the Vite plugin and the adapter directly in `vite.config.ts` — there is **no `svelte.config.js`** in this project. If you need to change adapter options or compiler options, edit `vite.config.ts`.
- `@sveltejs/adapter-vercel`'s runtime auto-detection only supports Node 20/22/24. If the local dev machine runs a newer Node (e.g. v26), `npm run build` fails with `Unsupported Node.js version` unless the adapter is given an explicit runtime. This is already set: `adapter({ runtime: 'nodejs22.x' })` in `vite.config.ts`. Don't remove it.
- **`package.json` pins `overrides: { "jsdom": "26.1.0" }` and that override is load-bearing on prod — do not drop it or bump jsdom.** `isomorphic-dompurify` pulls `jsdom`, and modern jsdom's tree contains ESM-only packages that its own CJS code `require()`s. **Vercel's serverless loader (`/opt/rust/nodejs.js` + `bytecode.js`) does not implement `require(ESM)` at all**, so the first module to touch DOMPurify throws `ERR_REQUIRE_ESM` — a 500 on **every** thread load and on the inbound webhook. There is more than one such package (jsdom 28+ `require`s `@exodus/bytes` from `lib/api.js`; jsdom 27's `cssstyle` → `@asamuzakjp/css-color@4` `require`s `@csstools/css-calc`'s `.mjs`), so **fixing them one at a time does not converge** — 26.1.0 is the newest jsdom whose whole tree loads under a no-`require(ESM)` loader.
  - **Local `dev`/`build`/`check` cannot catch this**: real Node ≥22.12 supports `require(ESM)`, so every gate passes while prod is completely broken. Reproduce Vercel's loader by disabling it — this is the only check that means anything here:

    ```sh
    NODE_OPTIONS=--no-experimental-require-module npx tsx -e \
      "import { prepareEmailHtml } from './src/lib/server/inbox/html.ts'; console.log(prepareEmailHtml('<p>x</p><img src=\"https://t.example/p.gif\">'))"
    ```

    That command failing = prod is down. Run it before touching anything in the DOMPurify/jsdom chain, and prefer pinning **jsdom itself** (a coherent published tree) over pinning a transitive dep outside the range jsdom declares.

  - Verified the downgrade is behaviour-neutral: `prepareEmailHtml` + `sanitizeEmailHtml` produce byte-identical output on jsdom 29 and 26.1.0 across styles, tables, `javascript:` hrefs, `cid:`/remote images, `style`/`script`/`iframe`, entities/unicode, media, and whitespace-only bodies.
  - Things that do **not** fix it, all tried on prod: bumping the adapter runtime to `nodejs24.x` (the loader intercepts the `require` regardless of Node version), overriding `html-encoding-sniffer` to 5.0.0 (it depends on `@exodus/bytes` too), and `jsdom@27` (the `cssstyle` chain above).
- `.prettierignore` excludes `/tasks/`, `/agents/`, and `/docs/demos/` — those are PRD/agent-process files and showboat demo logs, not app source, and are intentionally left unformatted by the app's prettier config.
- `docs/demos/<STORY_ID>.md` files are showboat proof-of-work logs (one per user story). When capturing command output in a showboat `exec` block for later `showboat verify` reproducibility, strip anything non-deterministic (timestamps, build durations, PIDs) with `grep`/`sed` before showboat records the output — otherwise `showboat verify` will fail on a re-run even though nothing is actually broken.

## Detailed notes (read the relevant file before touching that area)

This file is the index. The load-bearing per-area detail — every invariant, every "don't undo this" and why — lives in `docs/notes/`. **Read the matching file before working in that area**; the summaries here are pointers, not the whole contract. When a story establishes something a later story must know, write it into the matching note (and add a note file for a genuinely new area) rather than growing this index.

- [`docs/notes/infrastructure.md`](docs/notes/infrastructure.md) — Turso/Drizzle (`db` singleton, `schema.ts`, `db:push`, FK-enforcement and child-before-parent deletes) and Cloudflare R2 (private bucket, presign on demand, server-only imports).
- [`docs/notes/inbound.md`](docs/notes/inbound.md) — Svix signature verification, the metadata-only `email.received` payload, `parse.ts`, the endpoint's 200-vs-500 status contract, write-path HTML sanitization, `storeInboundEmail`'s single transaction and double idempotence, threading, and attachment upload/undo.
- [`docs/notes/inbox-list.md`](docs/notes/inbox-list.md) — `listInboxThreads` (one query, inner join carries both preview and soft-delete rule), the pure `format.ts`/`filter.ts`/`search.ts`/`params.ts` helpers, `resolve()` route-id gotchas, and unread treatment (`markThreadRead`, preload opt-down).
- [`docs/notes/thread-view.md`](docs/notes/thread-view.md) — `listThreadEmails`, the two 404s, and the whole US-G02 HTML story: the sandboxed `srcdoc` iframe, per-message remote-image blocking, height measurement, link interception, and the CSP.
- [`docs/notes/compose.md`](docs/notes/compose.md) — the pure `lib/compose/addresses.ts` (one definition of "sendable", shared by the Send gate and the action), the recipient field's combobox, the `send` action's validate → send → store order, and what Resend does and doesn't do to the threading headers (it rewrites `Message-ID`, preserves `In-Reply-To`/`References` — measured, and load-bearing for US-H03).
- [`docs/notes/auth.md`](docs/notes/auth.md) — the `(app)` route-group choke point, session cookie vs `sessions` table, `hashAuthCode`, the atomic auth-code helpers, `request-code`/`verify-code`/`logout`, and the login page's conventions.
- [`docs/notes/ui.md`](docs/notes/ui.md) — Dusk Terminal tokens in `layout.css` (`--dt-*` vs `--color-*`, radius capped 2-4px, motion vars), the theme toggle, the app shell, and the shared `EmptyState`/`Skeleton`/`ErrorMessage` contract.

## Cross-cutting rules

These apply everywhere, so they stay in the index:

- **`(app)/+layout.server.ts` protects page _renders_ — not endpoints, and not form actions.** A layout `load` never runs for a `+server.ts` request, and for a form action it runs _after_ the action, so **anything mutating added under `(app)/` must call `validateSession` itself** or it is an unauthenticated hole in the route group (an action would complete the mutation and only then redirect the anonymous caller to `/login`). See `docs/notes/auth.md`; `inbox/[threadId]/attachments/[attachmentId]/+server.ts` and `inbox/[threadId]/+page.server.ts`'s `deleteMessage` action are the worked examples. `compose/+page.server.ts`'s `send` action follows the rule _before_ it mutates anything (US-H01 sends nothing) so that US-H02 cannot forget it.
- **Server-only modules stay server-only.** Anything importing `src/lib/server/db`, `src/lib/server/r2` or `$env/dynamic/private` may only be imported from `+page.server.ts`, `+server.ts` or `src/lib/server/**`.
- **Env reads in anything a route can reach are lazy, not import-time** (see `email/resend.ts`, `webhooks/svix.ts`): `npm run build` imports every `+server.ts` during method detection, so an import-time secret check makes the build require real credentials. `db`/`r2` predate this and read at import time.
- **Query helpers take the db handle as their first argument**, typed as `Database` from `src/lib/server/db/types.ts` (a union of the singleton and a transaction handle). That is what lets them run inside a transaction _and_ run under a standalone `tsx` script that builds its own client from `process.env`.
- **Pure modules stay pure** (no env/db/DOM): `inbound/parse.ts`, `inbound/threading.ts`, `lib/inbox/format.ts`, `filter.ts`, `search.ts`, `params.ts`, `srcdoc.ts`, `lib/compose/addresses.ts`. That's what lets the load, the components and the `tsx` verification scripts share one implementation.
- **A module a `tsx` script loads must import by relative path, not `$lib/...`** — bare `tsx` has no Vite alias resolution. Currently constrains `server/db/inbox.ts`, `server/inbox/html.ts` and `lib/compose/addresses.ts`.
- **Extend the existing `verify-*.mts` script for an area rather than adding a new ad hoc one**: `db/verify-schema.mts`, `r2/verify.mts`, `auth/verify-auth-sessions.mts`, `webhooks/verify-inbound-webhook.mts`, `inbound/verify-inbound-parse.mts`, `db/verify-inbox-list.mts`, `compose/verify-compose-addresses.mts`, `outbound/verify-outbound-send.mts`. Wrap live-DB work in `try`/`finally` so seeded rows are cleaned up.
- **Every internal `<a href="/...">` or programmatic navigation must go through `resolve(...)` from `$app/paths`** — `svelte/no-navigation-without-resolve` fails `npm run lint` otherwise. Dynamic routes need the route group in the id: `resolve('/(app)/inbox/[threadId]', { threadId })`.
- `svelte/no-unused-props` is on, and it rejects a declared `Props` field the component never reads — don't declare a prop for a later story.
- **All env vars are real and current** in both the local `.env` (gitignored) and Vercel project settings — Turso, R2, Resend API key + recipient, inbound webhook secret. No placeholders remain, so treat a credential failure as a real bug. `.env.example` documents every name with empty values.
- Deployed from `main` to `https://mail.caseynazelrod.com`; **inbound addresses are on the apex** (`something@caseynazelrod.com`) because Resend holds the apex MX.
- `src/lib/server/db/seed-f03-demo.mts` is the shared browser-demo seeder (read thread, unread thread, three-message conversation, three contacts for the compose autocomplete, `123456` login code; `--cleanup` removes it all). Reuse it instead of seeding by hand, and see `docs/notes/inbox-list.md` for how to get a real session cookie in the browser.

## Workflow

- This repo follows the Ralph per-story branch + PR workflow described in `agents/ralph.md`, driven by `agents/prd.json`. One story per branch/PR; the agent opens the PR, runs `/code-review` on it, fixes findings and re-reviews until a pass is clean, then squash-merges to `main` itself.
- **One story per session.** After a merge, the next story starts in a fresh session (`/clear`), so each story is implemented by an agent whose context is `main` + the docs rather than the accumulated transcript of earlier stories. That's what makes `agents/ralph.md`, `agents/progress.txt` and this file the actual handoff — anything a later story needs to know has to be written down in one of them before the merge, not left in conversation.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
