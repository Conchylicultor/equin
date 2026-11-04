import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The build progress log family: `build-progress.jsonl` plus the two rotations
 * `defineFileSink` keeps beside it.
 *
 * A directory rather than three loose files at the root, because the rotations
 * ARE the history: a reader that opens only the live file silently truncates it
 * at the last rotation, and this box routinely runs several builds at once.
 *
 * Host-global on purpose — a wedged build is investigated from whichever shell
 * is free, not from the worktree that wedged.
 */
export const buildProgressLogDir = defineDataDir({
  kind: "logs",
  name: "build-progress",
  owner: "framework/cli",
  description:
    "Per-build progress log (`build-progress.jsonl` + rotations): one JSONL line per build open, span enter/leave with RSS, 30s heartbeat and completion, host-global across worktrees",
  // Observability output. Losing it costs the record of a past build — the
  // build itself is re-runnable and its receipt lives elsewhere.
  reclaim: { kind: "safe" },
  logs: [{ pattern: "build-progress.jsonl", bound: { kind: "file-sink" } }],
});

export default [buildProgressLogDir];
