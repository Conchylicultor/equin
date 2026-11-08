// The op log's CLI half: the writer an op process records itself with
// (`createOpProfiler`, writing synchronously — an event must be on disk before
// the process can die) and the direct fold of the file `./equin await` reads,
// which must never depend on the DB. A backend reads ops from op-store's rows
// and writes through `appendOpLog` (the server barrel), never from here.
export { appendOpLogSync } from "./internal/jsonl";
export { createOpProfiler } from "./internal/profiler";
export type { OpProfiler, OpProfilerOptions } from "./internal/profiler";
export {
  readOpenWait,
  readOpenWaitInLine,
  readOpRecords,
  readOpStates,
} from "./internal/read";
