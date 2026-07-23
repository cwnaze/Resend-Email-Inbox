# Provision Cloudflare R2 for attachment storage

*2026-07-22T20:45:10Z by Showboat 0.6.1*
<!-- showboat-id: ea814002-baca-4b19-878b-5b6c44d306ab -->

US-A02 provisions Cloudflare R2 (S3-compatible API) for private attachment storage. Three small server-only utility functions live in src/lib/server/r2/index.ts: uploadToR2 (Buffer/Blob -> object key), deleteFromR2 (delete by key), and getR2SignedDownloadUrl (time-limited presigned GET URL, default 15 min). The bucket is private (no public URL/custom domain), so there is no R2_PUBLIC_URL_BASE env var - downloads always go through a freshly generated presigned URL. Real R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME) already live in the gitignored root .env, provisioned by the project owner before this story started.

```bash
npm run check 2>&1 | grep -E 'ERRORS|check$' | sed -E 's/^[0-9]+ //'
```

```output
> resend-email-inbox@0.0.1 check
COMPLETED 1167 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```

```bash
npm run lint 2>&1 | tail -5
```

```output
> resend-email-inbox@0.0.1 lint
> prettier --check . && eslint .

Checking formatting...
All matched files use Prettier code style!
```

```bash
npm run build 2>&1 | tail -5
```

```output

Run npm run preview to preview your production build locally.

> Using @sveltejs/adapter-vercel
  ✔ done
```

Verification against the real R2 bucket uses the committed `src/lib/server/r2/verify.mts` helper (run outside SvelteKit via tsx, since `$env/dynamic/private` only resolves inside Vite/SvelteKit): it uploads a small text object via the same S3-compatible calls as `uploadToR2`, generates a presigned GET URL via the same call as `getR2SignedDownloadUrl`, fetches through that URL, deletes the object via the same call as `deleteFromR2`, then confirms a fresh presigned URL for the now-deleted key 404s. No secrets appear in the captured output (only booleans/status codes).

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/r2/verify.mts 2>&1
```

```output
upload: ok
presigned url is https: true
fetch via presigned url status: 200
fetched body matches: true
delete: ok
fetch after delete status (expect 4xx): 404
```
