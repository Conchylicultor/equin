import { readdir, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { readEnvPath } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  isMigrationFileName,
  migrationsFrom,
  type Migration,
} from "@plugins/database/plugins/migrations/server";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// A packaged release reads the migration SQL files from a vendored dir via env
// override: `import.meta.dir` resolves into the compiled binary's virtual FS
// (not a real on-disk path), so the `../../data` relative lookup can't find the
// `.sql` files. The release vendors `data/` and points here. When unset (dev),
// resolve relative to this module as before.
// The release launcher sets the env override to its own vendored dir.
export const MIGRATIONS_DIR: AppPath =
  readEnvPath("MIGRATIONS_DIR") ??
  asAppPath(join(import.meta.dir, "..", "..", "data"));

/** Every migration file in `dir`, in timestamp order (`migrationsFrom`). */
export async function listMigrationFiles(dir: AppPath): Promise<Migration[]> {
  const files = (await readdir(dir)).filter(isMigrationFileName);
  return migrationsFrom(
    await Promise.all(
      files.map(async (file) => ({
        file,
        sqlText: await readFile(joinAppPath(dir, file), "utf8"),
      })),
    ),
  );
}
