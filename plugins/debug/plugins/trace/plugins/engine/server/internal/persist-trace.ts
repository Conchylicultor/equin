import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { db } from "@plugins/database/server";
import type { TripContext, TraceSnapshot } from "../../core";
import { tracesProducer } from "./producer";

// Assemble the snapshot envelope and insert one durable row through the traces
// change producer (./producer), which routes the new id to the live list and
// lookup. Runs inside the engine's runWithoutProfiling scope (its caller), so
// the insert never re-feeds the profiler. The flat trigger* / duration* /
// threshold* columns duplicate the snapshot's trigger so the list never
// projects the blob.
export async function persistTrace(
  ctx: TripContext,
  events: Record<string, unknown>,
): Promise<void> {
  const snapshot: TraceSnapshot = {
    v: 2,
    id: ctx.id,
    atMs: ctx.atMs,
    wallTime: ctx.wallTime,
    worktree: runtimeNamespace(),
    windowStartMs: ctx.windowStartMs,
    trigger: ctx.trigger,
    events,
  };

  await tracesProducer.mutate(
    db,
    (q, t) =>
      q.insert(t).values({
        id: ctx.id,
        worktree: snapshot.worktree,
        triggerKind: ctx.trigger.kind,
        triggerLabel: ctx.trigger.label,
        durationMs: ctx.trigger.durationMs,
        thresholdMs: ctx.trigger.thresholdMs,
        snapshot,
      }),
    { latency: "background" },
  );
}
