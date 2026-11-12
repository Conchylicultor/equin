import type { WorktreeOpInfo } from "@plugins/infra/plugins/worktree/server";
import type { IdleBlockerReading } from "@plugins/infra/plugins/host/plugins/idle/core";

/**
 * What the running ops say about idleness. Every live op is work someone
 * waits on — except an OPPORTUNISTIC one (the idle test batch): it runs only
 * because the host is idle, and counting it would end the idle period it
 * runs in.
 */
export function opsReading(ops: readonly WorktreeOpInfo[]): IdleBlockerReading {
  const working = ops.filter((o) => !o.opportunistic);
  const n = working.length;
  const kinds = [...new Set(working.map((o) => o.op))].sort().join(", ");
  return {
    busy: n > 0,
    label:
      n === 0
        ? "no op running"
        : `${n} ${n === 1 ? "op" : "ops"} running (${kinds})`,
    // Every op start and end is a marker written or removed in the watched
    // dir; a SIGKILLed op's marker stays, but its flock is gone and the next
    // read reaps it — read on the next change, or any other blocker's.
    recheckAt: null,
  };
}
