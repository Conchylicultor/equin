import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";

/**
 * Whether `exec` is an open drizzle transaction (`NodePgTransaction`,
 * `PgliteTransaction`, a savepoint inside one) rather than a database handle
 * whose every statement autocommits (`db` — a forwarding Proxy whose prototype
 * is `Object`'s — or a test fixture's drizzle instance). The handle's own class
 * answers it, so no caller can claim a transaction it is not in.
 */
export function isOpenTransaction(exec: object | undefined): boolean {
  return exec !== undefined && is(exec, PgTransaction);
}
