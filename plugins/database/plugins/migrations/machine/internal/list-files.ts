import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isMigrationFileName,
  migrationsFrom,
  type Migration,
} from "@plugins/database/plugins/migrations/server";

// A packaged release reads the migration SQL files from a vendored dir via env
// override: `import.meta.dir` resolves into the compiled binary's virtual FS
// (not a real on-disk path), so the `../../data` relative lookup can't find the
// `.sql` files. The release vendors `data/` and points here. When unset (dev),
// resolve relative to this module as before.
export const MIGRATIONS_DIR =
  process.env.SINGULARITY_MIGRATIONS_DIR ??
  join(import.meta.dir, "..", "..", "data");

/** Every migration file in `dir`, in timestamp order (`migrationsFrom`). */
export function listMigrationFiles(dir: string): Migration[] {
  return migrationsFrom(
    readdirSync(dir)
      .filter(isMigrationFileName)
      .map((file) => ({
        file,
        sqlText: readFileSync(join(dir, file), "utf8"),
      })),
  );
}
