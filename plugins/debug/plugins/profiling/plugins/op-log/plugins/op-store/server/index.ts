import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { opLogOpsRetention } from "./internal/retention";
import { opLogWatcher, startOpStore, stopOpStore } from "./internal/service";

// NEVER import this barrel from CLI code: it pulls the database module, and the
// CLI writes the op log precisely because it must not depend on the DB.
// Browser readers use the `core` collections; the table is exported for
// server-side aggregates (stats/pushes) — read-only: the ingester is its only
// writer.
export { _opLogOps } from "./internal/tables";

export default {
  description:
    "Op-log read model: every serving backend ingests the host-global op-log.jsonl (and its rotations) into its own op_log_ops table behind a durable (inode, offset) cursor committed with the rows, reconciles in-flight ops whose process is gone (main appends a reconciler terminal to the log; a worktree closes locally only after an ingest gap), with a 30-day retention sweep. The machine half serves the rows as the opsInFlight and opsHistory live collections.",
  register: [opLogOpsRetention, opLogWatcher],
  // Every serving backend: drain first (the boot-preloaded in-flight rows may
  // be stale), then reconcile, then watch.
  onReady: startOpStore,
  onShutdown: stopOpStore,
} satisfies ServerPluginDefinition;
