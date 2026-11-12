import { cp } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "@plugins/config_v2/server";
import { configDir as userConfigDir } from "@plugins/config_v2/data-dirs";
import { hasCompositionMarker } from "@plugins/infra/plugins/worktree/server";
import type { BackupSourceReport } from "@plugins/backup/core";
import { configSourceConfig } from "../../shared/config";
import {
  scanGlob,
  exists,
  readdir,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  classifyScopes,
  describeLeftOut,
  backedUpScopes,
} from "./select-scopes";

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

  // One subtree per namespace; every one but a worktree's is copied (see
  // `select-scopes`). A worktree's subtree is never touched, so the reaper
  // removing one mid-run cannot fail the copy.
  const classified = await classifyScopes(
    await readdir(configDir),
    hasCompositionMarker,
  );
  const items = [];
  let sizeBytes = 0;
  for (const { name, kind } of backedUpScopes(classified)) {
    const out = join(dir, name);
    await cp(join(configDir, name), out, { recursive: true });
    const counted = await countFilesAndSize(out);
    items.push({
      label: name,
      detail:
        kind === "orphan"
          ? `${counted.count} files (no app owns this subtree)`
          : `${counted.count} files`,
      count: counted.count,
    });
    sizeBytes += counted.sizeBytes;
  }

  return {
    id: "config",
    name: "Config",
    outcome: "included",
    items,
    leftOut: describeLeftOut(classified),
    sizeBytes,
  };
}
