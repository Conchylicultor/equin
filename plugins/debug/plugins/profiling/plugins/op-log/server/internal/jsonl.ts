import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";
import { opLogDir } from "../../data-dirs";

/** The new unified log. Append-only; every op kind writes here. */
export const OP_LOG_FILE = opLogDir.file("op-log.jsonl");

// The op log is the ONE writable durable artifact here. It is declared as a
// bounded file sink so it is enumerable in `getFileSinks()` and rotates at the
// 128 MB × 3 cap instead of
// growing without bound (the durable-sink invariant — see infra/file-sink).
// `append` IS the rotation, and the sink creates the containing directory and
// appends the trailing newline itself.
export const opLogSink = defineFileSink({
  id: "op-log",
  description:
    "Unified op log: one record per host-contending op (build / push / check) — the requested/granted/completed phases with their per-resource wait lists. Read by the Debug → Profiling op Gantt and stats/pushes.",
  path: OP_LOG_FILE,
});

/** Append one record to the op log through its bounded sink. */
export function appendOpLog(record: unknown): void {
  opLogSink.append(JSON.stringify(record));
}
