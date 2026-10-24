import { existsSync } from "node:fs";
import { cp, stat } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "@plugins/config_v2/server";
import { legacyAuthDir } from "@plugins/infra/plugins/secrets/data-dirs";
import { DATABASE_CONFIG_PATH } from "@plugins/database/core";
import type { BackupSourceReport } from "@plugins/backup/core";
import { singularityPlatformSourceConfig } from "../../shared/config";

async function countFilesAndSize(
  cwd: string,
): Promise<{ count: number; sizeBytes: number }> {
  let count = 0;
  let sizeBytes = 0;
  for await (const rel of new Bun.Glob("**/*").scan({ cwd, onlyFiles: true })) {
    count++;
    const s = await stat(`${cwd}/${rel}`);
    sizeBytes += s.size;
  }
  return { count, sizeBytes };
}

export async function assembleSingularityPlatform(
  dir: string,
): Promise<BackupSourceReport> {
  const { enabled } = getConfig(singularityPlatformSourceConfig);

  if (!enabled) {
    return {
      id: "singularity-platform",
      name: "equin platform",
      outcome: "skipped",
      items: [],
      sizeBytes: 0,
    };
  }

  const items = [];
  let sizeBytes = 0;

  // The pre-secrets-store token layout (recursive dir), taken from the `secrets`
  // plugin's own declaration rather than re-derived here.
  const authDir = legacyAuthDir.path;
  if (existsSync(authDir)) {
    const dest = join(dir, "auth");
    await cp(authDir, dest, { recursive: true });
    const { count, sizeBytes: dirSize } = await countFilesAndSize(dest);
    sizeBytes += dirSize;
    items.push({ label: "auth", detail: `${count} files` });
  }

  // database.json — named through the one path the `database` plugin's core
  // barrel exports, which is derived from its `state/db-config` declaration.
  const databaseJsonPath = DATABASE_CONFIG_PATH;
  if (existsSync(databaseJsonPath)) {
    const dest = join(dir, "database.json");
    await cp(databaseJsonPath, dest);
    const s = await stat(dest);
    sizeBytes += s.size;
    items.push({ label: "database.json" });
  }

  // NO `crashes/` arm. It was the pre-rename spelling of the crash buffer, which
  // `reports` has owned as `reports/` for a long time — nothing has written
  // `crashes/` since, so the arm could only ever copy a stale leftover, and on
  // this machine it silently copied nothing at all. The buffer that DOES exist
  // is short-lived by design (flushed into the reports table on the next boot),
  // so it is not a backup source; it is not re-added here under the new name.

  return {
    id: "singularity-platform",
    name: "equin platform",
    outcome: "included",
    items,
    sizeBytes,
  };
}
