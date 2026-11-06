import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { watchDuress } from "./internal/latch";

// The directory the latch lives in, declared in this plugin's `data-dirs/`.
// Surfaced here for the consumers that must watch it rather than read it: the
// CLI's admission valve puts an `fs.watch` on it so a duress clear wakes a held
// build immediately, with no poll loop; the sentinel's status watcher serves it.
export { duressLatchDir } from "../data-dirs";

export {
  clearDuress,
  duressEpisode,
  duressLatchFaultSink,
  FRESHNESS_LEASE_MS,
  isUnderDuress,
  LATCH_FILENAME,
  readDuress,
  readFreshDuress,
  refreshDuress,
  setDuress,
} from "./internal/latch";
export type {
  DuressLatch,
  DuressLatchFault,
  DuressReading,
} from "./internal/latch";

export default {
  description:
    "The host-global duress latch file (mtime-leased, set/refresh/clear by the cluster sentinel, read via the free synchronous isUnderDuress() from an in-process copy a watch on the latch dir keeps current). A leaf on purpose: module-eval depends only on node:fs + infra/paths — no config, no DB, no worktree identity — so env-independent processes (the CLI's build admission valve, the sentinel's worker) can import it safely.",
  // Before any dependent's hook: the gate answers from the file, never from
  // not-known-yet, by the time a plugin that reads it starts.
  onReadyBlocking: watchDuress,
} satisfies ServerPluginDefinition;
