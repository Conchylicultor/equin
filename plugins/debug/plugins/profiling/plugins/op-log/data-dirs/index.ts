import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The unified op log family: `op-log.jsonl` plus the three rotations
 * `defineFileSink` keeps beside it.
 *
 * A directory rather than four loose files at the root, because the rotations
 * ARE the history — this file is the one durable record of every build, push and
 * check the host has run, and a reader that opens only the live file silently
 * truncates that record at the last rotation.
 *
 * Host-global on purpose: an op's contention is a property of the box, so the
 * question "what else was running when this build stalled?" can only be answered
 * from one shared log.
 */
export const opLogDir = defineDataDir({
  kind: "logs",
  name: "op-log",
  owner: "debug/profiling/op-log",
  description:
    "The unified build/push/check op log (`op-log.jsonl` + rotations): one JSONL line per op with its per-resource wait list, host-global across worktrees",
  // Observability output. Losing it costs past op history — the Gantt goes
  // blank for those runs — never anything a future op needs to run correctly.
  reclaim: { kind: "safe" },
  logs: [{ pattern: "op-log.jsonl", bound: { kind: "file-sink" } }],
});

export default [opLogDir];
