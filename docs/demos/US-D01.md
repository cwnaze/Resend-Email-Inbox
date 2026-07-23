# Define and migrate core schema

*2026-07-23T14:57:07Z by Showboat 0.6.1*
<!-- showboat-id: 1ea37da7-71fe-4c06-9cd7-68841d96a2cc -->

Full Drizzle schema for contacts, threads, emails, attachments, auth_codes, sessions defined in src/lib/server/db/schema.ts per tasks/prd-data-model.md. Applied to the real Turso database via drizzle-kit push, then verified table/index DDL and constraint enforcement directly against libSQL.

```bash
npm run db:push -- --force 2>&1 | grep -v '⣷\|⣯\|⣟\|⡿\|⢿\|⣻\|⣽'
```

```output

> resend-email-inbox@0.0.1 db:push
> drizzle-kit push --force

No config path provided, using default 'drizzle.config.ts'
Reading config file '/Users/bloodintern1/Desktop/Resend-Email-Inbox/drizzle.config.ts'
[2K[1G[✓] Pulling schema from database...

[i] No changes detected
```

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/db/verify-schema.mts
```

```output
PASS: all 6 tables present
PASS: all 8 indexes present
PASS: FK constraint rejects orphan thread_id
PASS: UNIQUE constraint rejects duplicate message_id
```

```bash
npm run check 2>&1 | sed -E 's/^[0-9]{10,} //'
```

```output

> resend-email-inbox@0.0.1 check
> svelte-kit sync && svelte-check --tsconfig ./tsconfig.json

START "/Users/bloodintern1/Desktop/Resend-Email-Inbox"
COMPLETED 1167 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```

```bash
npm run lint 2>&1
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
