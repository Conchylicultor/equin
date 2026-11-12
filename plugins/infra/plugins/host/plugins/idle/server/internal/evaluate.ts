import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { EmitTx } from "@plugins/infra/plugins/events/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { isHostSingleton } from "@plugins/infra/plugins/paths/core";
import {
  HOST_IDLE_STATE_ID,
  nextIdleState,
  type BlockerReading,
  type HostIdleRecord,
} from "../../core";
import { IdleBlocker, type IdleBlockerEntry } from "./registry";
import { _hostIdleState } from "./tables";
import { hostIdleBegan, hostIdleEnded } from "./tables-events";

// The host idle evaluation: ONE evaluator (the host singleton — main's
// backend), run whenever a blocker says its input changed and when the state
// machine asks to be woken (the end of the sustain window, a blocker's
// recheck). Never on a timer of its own.
//
// Two jobs, not one re-enqueueing itself with `runAt`. A keyed / singleton
// enqueue with `runAt` does move the pending row (graphile's default `replace`
// mode; the in-process queue's collapse), but a run releases its key while it
// runs: a blocker's request landing mid-run is a fresh row due NOW, and the
// run's own re-enqueue with `runAt = sustain end` would then push that row out
// by minutes — the request lost. So the sustain timer is its own singleton
// (`host-idle.wake`): moving it never moves a requested evaluation.

/** Every read of one evaluation: each blocker's, settled one by one. */
async function readBlockers(
  blockers: readonly IdleBlockerEntry[],
): Promise<{ readings: BlockerReading[]; failures: unknown[] }> {
  const settled = await Promise.allSettled(blockers.map((b) => b.read()));
  const failures: unknown[] = [];
  const readings = settled.map((s, i): BlockerReading => {
    const id = blockers[i]!.id;
    if (s.status === "fulfilled") return { id, ...s.value };
    failures.push(s.reason);
    // A blocker that cannot answer may be hiding work: the host is not idle
    // on its word. The evaluation still fails (below), so it is reported.
    return {
      id,
      busy: true,
      label: `could not be read: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
      recheckAt: null,
    };
  });
  return { readings, failures };
}

/**
 * The state the last evaluation wrote, or `null` before the first. For work
 * started on idle time that must re-check, before each next step, that the
 * host is still idle (an `idleEnded` it has not acted on yet).
 */
export async function readHostIdleRecord(): Promise<HostIdleRecord | null> {
  const [row] = await db
    .select()
    .from(_hostIdleState)
    .where(eq(_hostIdleState.id, HOST_IDLE_STATE_ID));
  if (row === undefined) return null;
  return {
    state: row.state,
    quietSince: row.quietSince?.getTime() ?? null,
    idleSince: row.idleSince?.getTime() ?? null,
  };
}

/**
 * One evaluation: read every blocker, fold them into the next state, write it
 * and emit its transition in one transaction, then arm the wake-up. A blocker
 * whose read failed counts as busy and fails the run after the write — the
 * state is safe and the failure is loud.
 */
export async function evaluateHostIdle(
  now: number = Date.now(),
  blockers: readonly IdleBlockerEntry[] = IdleBlocker.getContributions(),
): Promise<void> {
  const { readings, failures } = await readBlockers(blockers);
  const step = nextIdleState(await readHostIdleRecord(), readings, now);
  const at = new Date(now);
  const values = {
    state: step.next.state,
    quietSince:
      step.next.quietSince === null ? null : new Date(step.next.quietSince),
    idleSince:
      step.next.idleSince === null ? null : new Date(step.next.idleSince),
    evaluatedAt: at,
    wakeAt: step.wakeAt === null ? null : new Date(step.wakeAt),
    blockers: readings.map(({ id, busy, label }) => ({ id, busy, label })),
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(_hostIdleState)
      .values({ id: HOST_IDLE_STATE_ID, ...values })
      .onConflictDoUpdate({ target: _hostIdleState.id, set: values });
    const payload = { at: at.toISOString() };
    if (step.transition === "began")
      await hostIdleBegan.emit(payload, { tx: tx as EmitTx });
    if (step.transition === "ended")
      await hostIdleEnded.emit(payload, { tx: tx as EmitTx });
  });
  if (step.wakeAt !== null)
    await idleWakeJob.enqueue({}, { runAt: new Date(step.wakeAt) });
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `[host-idle] ${failures.length} idle blocker(s) could not be read; counted as busy`,
    );
}

export const evaluateHostIdleJob = defineJob({
  name: "host-idle.evaluate",
  description:
    "Works out whether the computer is idle — no agent working, no build or test running, no duress — and announces when an idle period begins or ends, so idle-time work can start and stop.",
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  // One pending row collapses a burst of requests; `serial` keeps two
  // evaluations from interleaving their read-modify-write of the one row.
  dedup: "singleton",
  serial: true,
  run: async () => {
    await evaluateHostIdle();
  },
});

/** The sustain timer: due at the time the last evaluation asked to be woken. */
export const idleWakeJob = defineJob({
  name: "host-idle.wake",
  description:
    "Re-checks whether the computer is idle at the moment the last check asked for — when ten quiet minutes are up, or when a duress lease could lapse — since nothing else would announce it.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  // One pending row: each evaluation's enqueue moves it to its own wake time.
  dedup: "singleton",
  run: async () => {
    await evaluateHostIdleJob.enqueue({});
  },
});

/**
 * A blocker's input changed: evaluate again. A no-op off the host singleton —
 * only main evaluates; another backend's blocker inputs are the same
 * host-wide state main already watches.
 */
export async function requestIdleEvaluation(): Promise<void> {
  if (!isHostSingleton()) return;
  await evaluateHostIdleJob.enqueue({});
}
