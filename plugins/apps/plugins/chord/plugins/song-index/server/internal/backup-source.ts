import { copyFile } from "node:fs/promises";
import { stat, existsSync } from "@plugins/packages/plugins/timed-fs/core";

import { basename, join } from "node:path";
import type { BackupSourceReport } from "@plugins/backup/core";
import { snapshotPath } from "./snapshot";

const ID = "chord-song-index";
const NAME = "Chord song index snapshot";

/**
 * Back up the song index's snapshot (~9 MB): the compact copy of Sheet Sage's
 * Hooktheory dump. The index tables are left out of backups because they are
 * rebuilt from this file; the file itself is kept because its sources are two
 * files on a third-party GitHub repository that may not stay there.
 *
 * Skipped when there is no snapshot — an instance that never opened the app
 * backs up nothing extra.
 */
export async function assembleSongIndexSnapshot(
  dir: string,
): Promise<BackupSourceReport> {
  const path = snapshotPath();
  if (!existsSync(path)) {
    return { id: ID, name: NAME, outcome: "skipped", items: [], sizeBytes: 0 };
  }
  const target = join(dir, basename(path));
  await copyFile(path, target);
  const { size } = await stat(target);
  return {
    id: ID,
    name: NAME,
    outcome: "included",
    items: [
      {
        label: basename(path),
        detail: `${(size / 1e6).toFixed(1)} MB`,
        count: 1,
      },
    ],
    sizeBytes: size,
  };
}
