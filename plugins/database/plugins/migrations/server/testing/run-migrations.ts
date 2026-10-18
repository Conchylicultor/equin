import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { runMigrations as runMigrationList } from "../internal/runner";
import { MigrationSource } from "../internal/source";

/**
 * Every migration this host's `MigrationSource` lists, applied to `db` in one
 * transaction, with no derived layer — for a throwaway test database. Under
 * `bun test` the source is the desktop's (the preload provides the desktop
 * host's services), so this is the committed `data/*.sql`.
 */
export function runMigrations(db: NodePgDatabase): Promise<void> {
  return runMigrationList(db, MigrationSource.get().list());
}
