import { cp } from "node:fs/promises";
import { getConfig } from "@plugins/config_v2/server";
import { configDir as userConfigDir } from "@plugins/config_v2/data-dirs";
import type { BackupSourceReport } from "@plugins/backup/core";
import { configSourceConfig } from "../../shared/config";
import {
  scanGlob,
  exists,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";

async function countFilesAndSize(
  cwd: string,
): Promise<{ count: number; sizeBytes: number }> {
  let count = 0;
  let sizeBytes = 0;
  for await (const rel of scanGlob("**/*", { cwd, onlyFiles: true })) {
    count++;
    const s = await stat(`${cwd}/${rel}`);
    sizeBytes += s.size;
  }
  return { count, sizeBytes };
}

export async function assembleConfig(dir: string): Promise<BackupSourceReport> {
  const { enabled } = getConfig(configSourceConfig);

  if (!enabled) {
    return {
      id: "config",
      name: "Config",
      outcome: "skipped",
      items: [],
      sizeBytes: 0,
    };
  }

  // Every worktree's subtree at once — the whole directory config_v2 declares,
  // not one namespace's slice of it.
  const configDir = userConfigDir.path;

  if (!(await exists(configDir))) {
    return {
      id: "config",
      name: "Config",
      outcome: "included",
      items: [],
      sizeBytes: 0,
    };
  }

  await cp(configDir, dir, { recursive: true });
  const { count, sizeBytes } = await countFilesAndSize(dir);

  return {
    id: "config",
    name: "Config",
    outcome: "included",
    items: [{ label: "config", detail: `${count} files`, count }],
    sizeBytes,
  };
}
