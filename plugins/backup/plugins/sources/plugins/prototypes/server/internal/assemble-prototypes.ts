import { existsSync } from "node:fs";
import { cp, readdir, stat } from "node:fs/promises";
import { getConfig } from "@plugins/config_v2/server";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import type { BackupSourceReport } from "@plugins/backup/core";
import { prototypesSourceConfig } from "../../shared/config";

const ID = "prototypes";
const NAME = "Prototypes";

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

/**
 * Back up the throwaway UI mockups in `~/.equin/apps/prototypes/`.
 *
 * They are deliberately NOT in git — a prototype is user content, and keeping it
 * out of the repo is what lets every worktree and main serve the same set with
 * no build and nothing to commit. That leaves this source as the thing standing
 * between a design exploration and losing it, so it is on by default.
 */
export async function assemblePrototypes(
  dir: string,
): Promise<BackupSourceReport> {
  const { enabled } = getConfig(prototypesSourceConfig);

  if (!enabled) {
    return { id: ID, name: NAME, outcome: "skipped", items: [], sizeBytes: 0 };
  }

  if (!existsSync(prototypesDir.path)) {
    return { id: ID, name: NAME, outcome: "included", items: [], sizeBytes: 0 };
  }

  await cp(prototypesDir.path, dir, { recursive: true });
  const { count, sizeBytes } = await countFilesAndSize(dir);
  const folders = (await readdir(dir, { withFileTypes: true })).filter((e) =>
    e.isDirectory(),
  ).length;

  return {
    id: ID,
    name: NAME,
    outcome: "included",
    items: [
      {
        label: "prototypes",
        detail: `${folders} prototype${folders === 1 ? "" : "s"}, ${count} files`,
        count: folders,
      },
    ],
    sizeBytes,
  };
}
