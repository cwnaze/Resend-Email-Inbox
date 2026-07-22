# Scaffold SvelteKit project with Tailwind CSS and Vercel adapter

*2026-07-22T19:35:13Z by Showboat 0.6.1*
<!-- showboat-id: 90050f7b-37e5-4612-b73b-e7c096301538 -->

Scaffolded a fresh SvelteKit project (TypeScript, Svelte 5 runes) via the official `sv create` CLI with the prettier, eslint, tailwindcss, and sveltekit-adapter(vercel) add-ons, merged into the repo root alongside the pre-existing tasks/ and agents/ directories.

```bash
npm run check 2>&1 | grep -E 'COMPLETED|ERRORS' | sed -E 's/^[0-9]+ //'
```

```output
COMPLETED 275 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
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
npm run build 2>&1 | grep -E 'Using @sveltejs/adapter-vercel|✔ done'
```

```output
> Using @sveltejs/adapter-vercel
  ✔ done
```

```bash
rodney open http://localhost:5173/ && rodney waitload && rodney text h1
```

```output
localhost:5173
Page loaded
Welcome to SvelteKit
```

```bash {image}
![Dev server placeholder page](docs/demos/dev-page-screenshot.png)
```

![Dev server placeholder page](e30e3e47-2026-07-22.png)
