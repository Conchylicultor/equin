import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readdir, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { dirname } from "node:path";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  claudeUsage,
  ClaudeUsageSchema,
  type ClaudeUsage,
  type ClaudeUsageRead,
} from "../../core";
import { claudeUsageDir } from "../../data-dirs";

const USAGE_FILE = /^(.+)\.json$/;

/** Every account's last report: one `<accountId>.json` per account. */
export async function readClaudeUsage(): Promise<ClaudeUsageRead> {
  const dir = claudeUsageDir.ensure();
  const byAccount: Record<string, ClaudeUsage> = {};
  for (const name of await readdir(dir)) {
    // The rename's temp file is `<file>.<pid>.tmp`.
    const id = USAGE_FILE.exec(name)?.[1];
    if (!id) continue;
    let text: string;
    try {
      text = await readFile(joinAppPath(dir, name), "utf8");
    } catch (err) {
      // Replaced between the listing and the read: the watch reads it again.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    byAccount[id] = ClaudeUsageSchema.parse(JSON.parse(text));
  }
  return { byAccount };
}

/**
 * Overwrite an account's usage file whole, through a rename, so a reader never
 * sees half of it — what an on-demand read records (the agent writes the same
 * way from its own process, `bin/agent.ts`).
 */
export async function writeClaudeUsageFile(
  path: AppPath,
  usage: ClaudeUsage,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // One write per account at a time (usage-probe's in-flight dedupe), so the
  // per-process temp name is never written twice at once.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(usage));
  await rename(tmp, path);
}

/**
 * `runtime-sdk.claude-usage`: re-read whenever an agent of any namespace
 * rewrites an account's usage file (the directory holds nothing else but the
 * renames' temp files).
 */
export const claudeUsageServed = serveValue(claudeUsage, {
  source: "external",
  changes: "notified",
  throttleMs: 250,
  loader: readClaudeUsage,
  whileSubscribed: async (_params, notify) => {
    const release = await acquireDirWatch({
      dir: claudeUsageDir.ensure(),
      scope: "subtree",
      onChange: () => notify(),
    });
    // A write between the first read and the watch opening produced no event.
    notify();
    return release;
  },
});
