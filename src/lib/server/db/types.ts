// Shared type for the Drizzle database handle.
//
// Server-only query-helper modules (e.g. `src/lib/server/auth/*.ts`) take this
// as their first argument rather than importing the `db` singleton directly.
// `import type` only pulls the type — it does not execute
// `src/lib/server/db/index.ts` — so those modules have no
// `$env/dynamic/private` dependency and can be exercised by standalone `tsx`
// verification scripts that build their own `drizzle(createClient(...))`
// instance from `process.env`. Declared here (rather than repeated per module)
// so the definition can't drift between them.
import type { db } from './index';

export type Database = typeof db;
