import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { OP_LOG_FILE, appendOpLog } from "./internal/jsonl";
export { createOpProfiler } from "./internal/profiler";
export type { OpProfiler, OpProfilerOptions } from "./internal/profiler";
export {
  readOpenWait,
  readOpenWaitInLine,
  readOpRecords,
  readOpStates,
} from "./internal/read";
export { readSleepNow } from "./internal/sleep-now";
// The pure types + fold live in `../core` (both runtimes share them); consumers
// import them from there. Only the fs/process-touching writer and reader live
// here; the orphan reconciler is the `op-store` child's (it reads the DB rows).

export default {
  description:
    "Unified op log: the one durable record for every host-contending op (build / push / check), its per-resource wait list, the writer, and the merged file reader. Its op-store child ingests it into the DB and owns the orphan reconciler.",
} satisfies ServerPluginDefinition;
