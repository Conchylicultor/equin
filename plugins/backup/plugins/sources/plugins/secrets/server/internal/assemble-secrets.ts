import { exists, stat } from "@plugins/packages/plugins/timed-fs/core";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "@plugins/config_v2/server";
import { secretsDir } from "@plugins/infra/plugins/secrets/data-dirs";
import type { BackupSourceReport } from "@plugins/backup/core";
import { secretsSourceConfig } from "../../shared/config";

export async function assembleSecrets(
  dir: string,
): Promise<BackupSourceReport> {
  const { enabled } = getConfig(secretsSourceConfig);

  if (!enabled) {
    return {
      id: "secrets",
      name: "Secrets",
      outcome: "skipped",
      items: [],
      sizeBytes: 0,
    };
  }

  const items = [];
  let sizeBytes = 0;

  const storePath = secretsDir.file("secrets.json.enc");
  if (await exists(storePath)) {
    const dest = join(dir, "secrets.json.enc");
    await cp(storePath, dest);
    const s = await stat(dest);
    sizeBytes += s.size;
    items.push({ label: "secrets.json.enc", detail: "encrypted" });
  }

  const keyPath = secretsDir.file(".key");
  if (await exists(keyPath)) {
    const dest = join(dir, ".key");
    await cp(keyPath, dest);
    const s = await stat(dest);
    sizeBytes += s.size;
    items.push({ label: ".key" });
  }

  return {
    id: "secrets",
    name: "Secrets",
    outcome: "included",
    items,
    sizeBytes,
  };
}
