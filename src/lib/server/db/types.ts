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
// The union with `Transaction` is what lets every helper below run unchanged
// both directly and inside a `db.transaction(...)` callback (see
// `inbound/store.ts`, which needs its thread + email writes to be atomic).
// Derived from the singleton's own `transaction` signature rather than named
// from `drizzle-orm`'s internals, so it can't drift from the real handle.
import type { db } from './index';

type DatabaseSingleton = typeof db;

export type Transaction = Parameters<Parameters<DatabaseSingleton['transaction']>[0]>[0];

export type Database = DatabaseSingleton | Transaction;
