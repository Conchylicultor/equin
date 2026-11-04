import { cp } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "@plugins/config_v2/server";
import { costUsageDir } from "@plugins/stats/plugins/cost/data-dirs";
import type {
  BackupSourceItem,
  BackupSourceReport,
} from "@plugins/backup/core";
import { costHistorySourceConfig } from "../../shared/config";
import {
  scanGlob,
  existsSync,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";

export async function assembleCostHistory(
  dir: string,
): Promise<BackupSourceReport> {
  const { enabled } = getConfig(costHistorySourceConfig);

  if (!enabled) {
    return {
      id: "cost-history",
      name: "Cost History",
      outcome: "skipped",
      items: [],
      sizeBytes: 0,
    };
  }

  const items: BackupSourceItem[] = [];
  let sizeBytes = 0;

  // sessions-<YYYY>.json — the year-sharded permanent archive. These are the
  // irreplaceable files: they hold cost history for transcripts Claude Code has
  // since deleted, so there is nothing on disk to rebuild them from.
  //
  // The glob is deliberately narrow. `index.json` is a rebuildable corpus cache
  // (re-derived from the live transcripts on the next parse) and `*.tmp` files
  // are the in-flight halves of an atomic temp+rename write — backing either up
  // would archive state that is either worthless or torn.
  let shards = 0;
  if (existsSync(costUsageDir.path)) {
    for await (const rel of scanGlob("sessions-*.json", {
      cwd: costUsageDir.path,
      onlyFiles: true,
    })) {
      const dest = join(dir, rel);
      await cp(costUsageDir.file(rel), dest);
      sizeBytes += (await stat(dest)).size;
      shards++;
    }
  }
  // Reported even at zero: the archive writer ships alongside this source, so an
  // empty or not-yet-created directory is a legitimate empty success — "0 year
  // shards" says so, where an omitted item would look like the source never ran.
  items.push({
    label: "sessions",
    detail: `${shards} year shards`,
    count: shards,
  });

  // price-table.json — the merged LiteLLM rate table. Merge-only and never
  // pruned, so it is the only surviving record of prices for models LiteLLM has
  // since dropped; without it, old shards can no longer be re-priced.
  const priceTablePath = costUsageDir.file("price-table.json");
  if (existsSync(priceTablePath)) {
    const dest = join(dir, "price-table.json");
    await cp(priceTablePath, dest);
    sizeBytes += (await stat(dest)).size;
    items.push({ label: "price-table.json" });
  }

  return {
    id: "cost-history",
    name: "Cost History",
    outcome: "included",
    items,
    sizeBytes,
  };
}
