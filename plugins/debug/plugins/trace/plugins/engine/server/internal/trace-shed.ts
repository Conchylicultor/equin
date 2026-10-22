import {
  createShedBuffer,
  type ShedSummary,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/shed/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import type { TraceTrigger } from "../../core";

// Duress shed gate for trace capture (Phase C2 of the congestion-observability
// plan). During a host duress episode, past the first-N-per-cascade grant the
// ENTIRE capture is skipped — the synchronous coherent-instant phases are
// exactly the cost shedding exists to avoid, so unlike slow-ops/reports there
// is nothing worth buffering for replay. What IS buffered is a stub:
// a trace's value is its coherent instant, which is gone by flush time, so
// replay is a documented no-op — the stubs exist solely so the post-episode
// duress-shed summary's byCascade shed/dropped counts are truthful. No fake
// traces are ever fabricated.

/** The accounting stub buffered per shed trip — never persisted as a trace. */
export interface TraceShedStub {
  kind: string;
  label: string;
  wallTime: string;
  durationMs: number;
}

function shedSummaryMessage(s: ShedSummary): string {
  const shed = Object.values(s.byCascade).reduce((a, c) => a + c.shed, 0);
  const dropped = Object.values(s.byCascade).reduce((a, c) => a + c.dropped, 0);
  return (
    `duress episode cleared: ${s.kind} buffer shed ${shed} + dropped ${dropped} ` +
    `across ${Object.keys(s.byCascade).length} cascade keys ` +
    `(${s.replayed} replayed, ${s.replayErrors} replay errors)`
  );
}

const traceShed = createShedBuffer<TraceShedStub>({
  kind: "traces",
  // Same axis as trace admission (rate-limit.ts), so first-N counts along the
  // per-trigger cooldown identity.
  cascadeKeyOf: (s) => `${s.kind}:${s.label}`,
  // Documented no-op: the coherent instant a trace would have captured no
  // longer exists at flush time, so there is nothing to re-drive. The stubs
  // fold into the summary's shed/dropped accounting instead.
  replay: async () => {},
  // File the post-episode accounting through the reports funnel. The
  // `duress-shed` kind is registered by debug/duress-shed and marks itself
  // duressExempt, so this summary can never itself be shed.
  onFlushSummary: (s) => {
    void recordReport({
      kind: "duress-shed",
      source: "server-duress-shed",
      message: shedSummaryMessage(s),
      data: { ...s },
    });
  },
});

// Test seam: replaces the buffer's admit so tests can force shed/persist
// decisions without a booted config registry or a real latch. Pass null to
// restore. Mirrors duress's _setShedConfigForTests style (internal-only, not
// on the barrel).
let admitOverride: ((stub: TraceShedStub) => { persist: boolean }) | null =
  null;
export function _setTraceShedAdmitForTests(
  fn: ((stub: TraceShedStub) => { persist: boolean }) | null,
): void {
  admitOverride = fn;
}

/**
 * True when this trip must be shed (skip the entire capture, return null to
 * the caller — same contract as a rate-limited trip). A `critical` trigger
 * (cluster onset, frozen-backend stall) bypasses shedding entirely, without
 * consuming a first-N grant: the incident trace must always land, and duress
 * is precisely when it trips.
 */
export function shouldShedTrace(trigger: TraceTrigger): boolean {
  if (trigger.critical === true) return false;
  const stub: TraceShedStub = {
    kind: trigger.kind,
    label: trigger.label,
    wallTime: new Date().toISOString(),
    durationMs: trigger.durationMs,
  };
  const { persist } = admitOverride
    ? admitOverride(stub)
    : traceShed.admit(stub);
  return !persist;
}
