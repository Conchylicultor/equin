import { readdir, rm, stat } from "node:fs/promises";
import { backupsDir } from "@plugins/infra/plugins/paths/server";
import { getConfig } from "@plugins/config_v2/server";
import type { BackupArchive, BackupTargetResult } from "@plugins/backup/core";
import { localBackupConfig } from "../../shared/config";

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

export async function runLocalTarget(
  archive: BackupArchive,
): Promise<BackupTargetResult> {
  const { enabled, keepLast } = getConfig(localBackupConfig);

  if (!enabled) {
    return { targetId: "local", ok: true, detail: "disabled" };
  }

  let entries: string[];
  try {
    entries = await readdir(backupsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { targetId: "local", ok: true, detail: archive.archivePath };
  }

  // Only completed backups (those with a published archive.tar.gz) count toward
  // keepLast and are eligible for eviction. An interrupted run without an
  // archive must never be counted nor evict a good backup.
  const candidates = entries.filter((e) => TIMESTAMP_RE.test(e));
  const completed: string[] = [];
  for (const e of candidates) {
    try {
      await stat(`${backupsDir()}/${e}/archive.tar.gz`);
      completed.push(e);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const dirs = completed.sort().reverse();

  if (keepLast > 0 && dirs.length > keepLast) {
    const toDelete = dirs.slice(keepLast);
    for (const dir of toDelete) {
      await rm(`${backupsDir()}/${dir}`, { recursive: true, force: true });
    }
  }

  return { targetId: "local", ok: true, detail: archive.archivePath };
}
