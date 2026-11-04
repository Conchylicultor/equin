import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { getConfig } from "@plugins/config_v2/server";
import { CLAUDE_PROJECTS_DIR } from "@plugins/infra/plugins/paths/server";
import type { BackupSourceReport } from "@plugins/backup/core";
import { projectMemorySourceConfig } from "../../shared/config";
import {
  scanGlob,
  existsSync,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";

export async function assembleProjectMemory(
  dir: string,
): Promise<BackupSourceReport> {
  const { enabled } = getConfig(projectMemorySourceConfig);

  if (!enabled) {
    return {
      id: "project-memory",
      name: "Project Memory",
      outcome: "skipped",
      items: [],
      sizeBytes: 0,
    };
  }

  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    return {
      id: "project-memory",
      name: "Project Memory",
      outcome: "included",
      items: [],
      sizeBytes: 0,
    };
  }

  let totalCount = 0;
  let sizeBytes = 0;

  // Scan for */memory/ directories under CLAUDE_PROJECTS_DIR
  // Bun.Glob does not support onlyDirectories, so scan files under */memory/**/* instead
  const seen = new Set<string>();
  for await (const rel of scanGlob("*/memory/**/*", {
    cwd: CLAUDE_PROJECTS_DIR,
    onlyFiles: true,
  })) {
    // rel is like "<project>/memory/foo.md"
    const projectName = rel.split("/")[0];
    if (!projectName) continue;
    if (!seen.has(projectName)) {
      seen.add(projectName);
      const memoryDir = joinAppPath(CLAUDE_PROJECTS_DIR, projectName, "memory");
      if (existsSync(memoryDir)) {
        // Use encoded project name to avoid collisions (replace slashes with underscores)
        const encodedName = projectName.replace(/\//g, "_");
        const dest = join(dir, encodedName);
        await mkdir(dest, { recursive: true });
        await cp(memoryDir, dest, { recursive: true });
      }
    }
    totalCount++;
    const s = await stat(join(CLAUDE_PROJECTS_DIR, rel));
    sizeBytes += s.size;
  }

  const items =
    totalCount > 0
      ? [{ label: "memory", detail: `${totalCount} files`, count: totalCount }]
      : [];

  return {
    id: "project-memory",
    name: "Project Memory",
    outcome: "included",
    items,
    sizeBytes,
  };
}
