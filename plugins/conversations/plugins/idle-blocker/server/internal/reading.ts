import type { IdleBlockerReading } from "@plugins/infra/plugins/host/plugins/idle/core";

/** What `n` working agents say about idleness. */
export function agentsReading(n: number): IdleBlockerReading {
  return {
    busy: n > 0,
    label:
      n === 0
        ? "no agent working"
        : `${n} ${n === 1 ? "agent" : "agents"} working`,
    // Every status change is announced (conversation.statusChanged).
    recheckAt: null,
  };
}
