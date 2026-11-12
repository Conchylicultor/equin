import { worktreesDir } from "@plugins/infra/plugins/paths/server";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { TAB_MEMORY_SAMPLE_EVERY_MS, tabMemorySeries } from "../../core";
import { readTabMemory } from "./read";
import { TAB_MEMORY_CHANNEL } from "./sink";

const READ_FILES = new Set([
  `${TAB_MEMORY_CHANNEL}.jsonl`,
  "health-owners.jsonl",
]);

/**
 * A worktree's `logs/<channel>.jsonl` the loader reads — appended, rotated or
 * removed: `<root>/<wt>/logs/<file>`. Plain string work on the watcher's
 * absolute paths (this host's separator is "/").
 */
function movesAnswer(root: string, path: string): boolean {
  if (!path.startsWith(`${root}/`)) return false;
  const parts = path.slice(root.length + 1).split("/");
  return parts.length === 3 && parts[1] === "logs" && READ_FILES.has(parts[2]!);
}

/**
 * Notified by the files the loader reads, only while a tab is subscribed: one
 * subtree watch of the worktrees root (the shared dir hub) hears every
 * worktree's `tab-memory.jsonl` and main's `health-owners.jsonl`. Throttled:
 * health-owners appends every 30 s and each recompute re-reads every
 * worktree's log, while the figures move over hours — so at most once per
 * page sample period.
 */
export const tabMemorySeriesServed = serveValue(tabMemorySeries, {
  source: "external",
  changes: "notified",
  loader: readTabMemory,
  throttleMs: TAB_MEMORY_SAMPLE_EVERY_MS,
  whileSubscribed: async (_params, notify) => {
    const root = worktreesDir();
    const release = await acquireDirWatch({
      dir: root,
      scope: "subtree",
      onChange: (events) => {
        if (events.some((e) => movesAnswer(root, e.path))) notify();
      },
    });
    // An append between the first load and the watch opening produced no
    // event; one re-read closes that gap.
    notify();
    return release;
  },
});
