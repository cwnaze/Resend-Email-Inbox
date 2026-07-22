# Resend Email Inbox — Project Notes

## Stack

- SvelteKit (Svelte 5, runes mode forced via `vite.config.ts`'s `sveltekit({ compilerOptions: { runes: ... } })`), TypeScript, Tailwind CSS v4 (via `@tailwindcss/vite`, imported in `src/routes/layout.css` and pulled into `+layout.svelte`), `@sveltejs/adapter-vercel`.
- Package manager: npm. Scripts: `npm run dev`, `npm run build`, `npm run check` (typecheck via svelte-check), `npm run lint` (prettier --check + eslint), `npm run format`.

## Gotchas

- This SvelteKit toolchain (current `sv create` output) configures the Vite plugin and the adapter directly in `vite.config.ts` — there is **no `svelte.config.js`** in this project. If you need to change adapter options or compiler options, edit `vite.config.ts`.
- `@sveltejs/adapter-vercel`'s runtime auto-detection only supports Node 20/22/24. If the local dev machine runs a newer Node (e.g. v26), `npm run build` fails with `Unsupported Node.js version` unless the adapter is given an explicit runtime. This is already set: `adapter({ runtime: 'nodejs22.x' })` in `vite.config.ts`. Don't remove it.
- `.prettierignore` excludes `/tasks/`, `/agents/`, and `/docs/demos/` — those are PRD/agent-process files and showboat demo logs, not app source, and are intentionally left unformatted by the app's prettier config.
- `docs/demos/<STORY_ID>.md` files are showboat proof-of-work logs (one per user story). When capturing command output in a showboat `exec` block for later `showboat verify` reproducibility, strip anything non-deterministic (timestamps, build durations, PIDs) with `grep`/`sed` before showboat records the output — otherwise `showboat verify` will fail on a re-run even though nothing is actually broken.

## Workflow

- This repo follows the Ralph per-story branch + PR workflow described in `agents/ralph.md`, driven by `agents/prd.json`. One story per branch/PR, human merges.
