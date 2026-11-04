import { cp } from "node:fs/promises";
import { getConfig } from "@plugins/config_v2/server";
import { attachmentsDir } from "@plugins/infra/plugins/attachments/data-dirs";
import type { BackupSourceReport } from "@plugins/backup/core";
import { attachmentsSourceConfig } from "../../shared/config";
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

export async function assembleAttachments(
  dir: string,
): Promise<BackupSourceReport> {
  const { enabled } = getConfig(attachmentsSourceConfig);

  if (!enabled) {
    return {
      id: "attachments",
      name: "Attachments",
      outcome: "skipped",
      items: [],
      sizeBytes: 0,
    };
  }

  if (!existsSync(attachmentsDir.path)) {
    return {
      id: "attachments",
      name: "Attachments",
      outcome: "included",
      items: [],
      sizeBytes: 0,
    };
  }

  await cp(attachmentsDir.path, dir, { recursive: true });
  const { count, sizeBytes } = await countFilesAndSize(dir);

  return {
    id: "attachments",
    name: "Attachments",
    outcome: "included",
    items: [{ label: "attachments", detail: `${count} files`, count }],
    sizeBytes,
  };
}
