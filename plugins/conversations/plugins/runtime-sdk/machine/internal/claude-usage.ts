import { readFileSync } from "node:fs";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  claudeUsage,
  ClaudeUsageSchema,
  type ClaudeUsageRead,
} from "../../core";
import { claudeUsageDir } from "../../data-dirs";
import { claudeUsagePath } from "./paths";

function readUsage(): ClaudeUsageRead {
  let text: string;
  try {
    text = readFileSync(claudeUsagePath(), "utf8");
  } catch (err) {
    // No agent on this machine has reported the limits yet.
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "none" };
    throw err;
  }
  return { kind: "reported", usage: ClaudeUsageSchema.parse(JSON.parse(text)) };
}

/**
 * `runtime-sdk.claude-usage`: re-read whenever an agent of any namespace
 * rewrites the usage file (its directory holds nothing else but the rename's
 * temp file).
 */
export const claudeUsageServed = serveValue(claudeUsage, {
  source: "external",
  changes: "notified",
  throttleMs: 250,
  loader: readUsage,
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
