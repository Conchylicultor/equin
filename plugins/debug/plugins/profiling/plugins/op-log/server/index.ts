import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { OP_LOG_FILE, appendOpLog, opLogSink } from "./internal/jsonl";
export { readSleepNow } from "./internal/sleep-now";
// The pure types + fold live in `../core` (both runtimes share them); consumers
// import them from there. Only the fs-touching sink and the backend's writer
// live here; the CLI's writer (the op profiler) and its direct file reader are
// the `cli` barrel's, and the orphan reconciler is the `op-store` child's (it
// reads the DB rows).

export default {
  description:
    "Unified op log: the one durable record for every host-contending op (build / push / check), its per-resource wait list, the writer, and the merged file reader. Its op-store child ingests it into the DB and owns the orphan reconciler.",
} satisfies ServerPluginDefinition;
