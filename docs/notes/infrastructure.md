# Infrastructure — Turso/Drizzle + Cloudflare R2

## Database (Turso / Drizzle)

- `src/lib/server/db/index.ts` exports `db`, a `drizzle-orm/libsql` client built from `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` read via `$env/dynamic/private` (not `$env/static/private` — keeps the module importable even in contexts where those vars aren't statically inlined). Only import this from server-only code (`+page.server.ts`, `+server.ts`, `src/lib/server/**`).
- `src/lib/server/db/schema.ts` is the single Drizzle schema file; `drizzle.config.ts` (repo root, `dialect: 'turso'`) points at it and at `./drizzle` for generated migrations.
- Full schema (since US-D01): `contacts`, `threads`, `emails`, `attachments`, `auth_codes`, `sessions`, per `tasks/prd-data-model.md`. Booleans are `integer({ mode: 'boolean' })`, JSON address-list columns are `text({ mode: 'json' })`, timestamps are `integer({ mode: 'timestamp_ms' })`. Declare indexes via the `sqliteTable(name, columns, (table) => [index(...), uniqueIndex(...)])` array-builder form (current drizzle-orm API), and FKs via `.references(() => otherTable.column)` on the column definition. FK enforcement is connection-dependent: a plain local SQLite connection needs `PRAGMA foreign_keys = ON` before it will _reject_ a violation, but the remote Turso connection these scripts open **does** enforce them (observed in US-E04: deleting a `threads` row before its `emails` rows fails with `SQLITE_CONSTRAINT`). So always delete children before parents, and don't assume a violation will pass silently. `src/lib/server/db/verify-schema.mts` is a standalone script (same `process.env`-reading, `tsx`-run pattern as `src/lib/server/r2/verify.mts`) that smoke-tests the live schema — extend it rather than writing new ad hoc scripts for future schema changes.
- Real Turso credentials live only in the gitignored root `.env` (never commit them); `.env.example` documents the variable names with empty values.
- `npm run db:push` applies the schema directly to the configured Turso database (no migration files); `npm run db:generate` emits SQL migration files under `./drizzle` if a versioned-migration workflow is needed later; `npm run db:studio` opens Drizzle Studio.
- Both `drizzle.config.ts` and `src/lib/server/db/index.ts` throw at startup if either `TURSO_DATABASE_URL` or `TURSO_AUTH_TOKEN` is missing — a remote Turso connection needs both, so failing fast on either avoids a confusing runtime error from `@libsql/client` later.
- If a future story switches to `npm run db:generate` (versioned migrations instead of `db:push`), commit the generated `./drizzle/*.sql` files and the `./drizzle/meta` journal — they're a source-of-truth migration history, not disposable build output, so `./drizzle` should NOT be gitignored once it's in use.

## Object storage (Cloudflare R2)

- `src/lib/server/r2/index.ts` exports three server-only utilities: `uploadToR2(key, body, contentType?)`, `deleteFromR2(key)`, and `getR2SignedDownloadUrl(key, options?)` (default 15 min). As of US-G03 that second argument is `{ expiresInSeconds?, contentDisposition?, contentType? }`; the two response overrides become S3 `response-content-disposition`/`response-content-type` **signed query parameters**, so they are covered by the signature and whoever holds the URL cannot alter them. That is what lets a download link fix the filename the browser saves under without the stored object carrying it — see `docs/notes/thread-view.md` for how the attachment endpoint uses it (and for why the header values are escaped before being signed). Built on `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` against R2's S3-compatible API at `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.
- The bucket is **private** — there is no `R2_PUBLIC_URL_BASE`/static public URL. Any place the app needs to let the browser fetch/download an object must call `getR2SignedDownloadUrl` on demand rather than storing a permanent URL. This affects the `attachments` table (stores `r2_object_key`, not a public URL) and any UI that lists/downloads attachments. US-G03 is the worked example: `GET /inbox/[threadId]/attachments/[attachmentId]` presigns per click and 302s the browser to R2, and the object key never reaches the client.
- Required env vars: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (read via `$env/dynamic/private`, same pattern as the Turso vars). The module throws at import time if any are missing.
- Only import `src/lib/server/r2` from server-only code (`+page.server.ts`, `+server.ts`, `src/lib/server/**`) — same rule as the `db` client.

## R2 bucket CORS (US-H05)

The compose attachment picker uploads **directly from the browser** to R2 over a presigned PUT (Vercel's ~4.5 MB request-body cap makes posting a 25 MB file through a form action impossible). That is a cross-origin request, so the bucket must carry a CORS policy or the browser refuses the upload before it starts — the failure looks like an opaque network error in the console and `CORS not configured for this bucket` on an `OPTIONS` probe.

`src/lib/server/r2/set-cors.mts` is the single description of the policy and can be run against a bucket whose credentials allow it:

```
node --env-file=.env node_modules/.bin/tsx src/lib/server/r2/set-cors.mts
```

**It will 403 with the credentials in this repo.** `R2_ACCESS_KEY_ID` is an _Object_ Read & Write token; `PutBucketCors` needs _Admin_ Read & Write. The policy is therefore applied by hand in the Cloudflare dashboard (R2 → bucket → Settings → CORS Policy), and the script is kept as the authoritative record of what it should say:

```json
[
	{
		"AllowedOrigins": ["http://localhost:5173", "https://mail.caseynazelrod.com"],
		"AllowedMethods": ["PUT"],
		"AllowedHeaders": ["content-type"],
		"MaxAgeSeconds": 3600
	}
]
```

Never `*` for the origins. `PUT` only — downloads are presigned GETs the browser _navigates_ to (a 302 out of the download endpoint), which is not a CORS request at all. `content-type` must be allowed because the presigned PUT signs it, so the preflight fails without it.

Verify from a shell without any credentials:

```sh
curl -s -i -X OPTIONS "https://<account>.r2.cloudflarestorage.com/<bucket>/probe" \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: content-type"
```
