import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerContribution } from "@plugins/framework/plugins/server-core/core";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/core";
import {
  isMigrationFileName,
  migrationsFrom,
  MigrationSource,
} from "@plugins/database/plugins/migrations/server";

const MIGRATIONS_DATA = join(PLUGINS_DIR, "database/plugins/migrations/data");

/**
 * The committed migration history, read off disk — what the bundled source
 * (`migrations/bundled-source`) inlines with `import.meta.glob`, which Bun has
 * not. Imported lazily by `portable-host.ts`: loading this module declares the
 * migrations' host services.
 */
export function committedMigrations(): ServerContribution {
  return MigrationSource.provide({
    list: () =>
      migrationsFrom(
        readdirSync(MIGRATIONS_DATA)
          .filter(isMigrationFileName)
          .map((file) => ({
            file,
            sqlText: readFileSync(join(MIGRATIONS_DATA, file), "utf8"),
          })),
      ),
  });
}
