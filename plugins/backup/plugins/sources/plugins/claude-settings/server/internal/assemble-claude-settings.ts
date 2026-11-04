import { cp } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "@plugins/config_v2/server";
import { CLAUDE_DIR } from "@plugins/infra/plugins/paths/server";
import type { BackupSourceReport } from "@plugins/backup/core";
import { claudeSettingsSourceConfig } from "../../shared/config";
import {
  scanGlob,
  existsSync,
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

export async function assembleClaudeSettings(
  dir: string,
): Promise<BackupSourceReport> {
  const { enabled } = getConfig(claudeSettingsSourceConfig);

  if (!enabled) {
    return {
      id: "claude-settings",
      name: "Claude Settings",
      outcome: "skipped",
      items: [],
      sizeBytes: 0,
    };
  }

  const items = [];
  let sizeBytes = 0;

  // settings.json
  const settingsPath = join(CLAUDE_DIR, "settings.json");
  if (existsSync(settingsPath)) {
    const dest = join(dir, "settings.json");
    await cp(settingsPath, dest);
    const s = await stat(dest);
    sizeBytes += s.size;
    items.push({ label: "settings.json" });
  }

  // history.jsonl
  const historyPath = join(CLAUDE_DIR, "history.jsonl");
  if (existsSync(historyPath)) {
    const dest = join(dir, "history.jsonl");
    await cp(historyPath, dest);
    const s = await stat(dest);
    sizeBytes += s.size;
    items.push({ label: "history.jsonl" });
  }

  // plugins/installed_plugins.json
  const installedPluginsPath = join(
    CLAUDE_DIR,
    "plugins",
    "installed_plugins.json",
  );
  if (existsSync(installedPluginsPath)) {
    const dest = join(dir, "installed_plugins.json");
    await cp(installedPluginsPath, dest);
    const s = await stat(dest);
    sizeBytes += s.size;
    items.push({ label: "installed_plugins.json" });
  }

  // tasks/ (recursive dir)
  const tasksDir = join(CLAUDE_DIR, "tasks");
  if (existsSync(tasksDir)) {
    const dest = join(dir, "tasks");
    await cp(tasksDir, dest, { recursive: true });
    const { count, sizeBytes: dirSize } = await countFilesAndSize(dest);
    sizeBytes += dirSize;
    items.push({ label: "tasks", detail: `${count} files` });
  }

  // teams/ (recursive dir)
  const teamsDir = join(CLAUDE_DIR, "teams");
  if (existsSync(teamsDir)) {
    const dest = join(dir, "teams");
    await cp(teamsDir, dest, { recursive: true });
    const { count, sizeBytes: dirSize } = await countFilesAndSize(dest);
    sizeBytes += dirSize;
    items.push({ label: "teams", detail: `${count} files` });
  }

  return {
    id: "claude-settings",
    name: "Claude Settings",
    outcome: "included",
    items,
    sizeBytes,
  };
}
