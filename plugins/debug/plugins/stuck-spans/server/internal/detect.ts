import type {
  FlightSpan,
  SpanKind,
  WaitKind,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { STUCK_SPAN_POLICY, type StuckSpanPolicyTable } from "./policy";

// The detector, kept free of the recorder, the trace engine and the reports
// engine: it reads open spans from an injected source and hands new findings to
// an injected sink. `watchdog.ts` wires the real ones; the tests wire fakes and
// drive the clock through the spans' own `ageMs`.

/**
 * The fields of an open flight-window span the detector reads. The wait fields
 * are optional because an open span that never waited carries none of them
 * (`waitMs` is 0 then): a span with no wait is judged on its whole age.
 */
export type OpenSpan = Pick<
  FlightSpan,
  "id" | "parentId" | "kind" | "label" | "ageMs"
> &
  Partial<Pick<FlightSpan, "waitMs" | "pendingWaitMs" | "waiting">>;

export interface StuckAncestorSpan {
  id: number;
  kind: SpanKind;
  label: string;
  ageMs: number;
}

interface StuckSpanFindingBase {
  id: number;
  kind: SpanKind;
  label: string;
  /** How long the span has been open. */
  ageMs: number;
  thresholdMs: number;
  /** Still-open ancestors, OUTERMOST first, ending at the immediate parent. */
  ancestors: StuckAncestorSpan[];
}

/**
 * Why a span is stuck — the two are different findings about different
 * things, so a report never blames a waiter for its gate:
 *
 * - `own-work`: it has spent its threshold on something other than waiting on
 *   a gate (`ownMs`: its age less every wait in its subtree, ended or still
 *   in progress) — the span is the cause.
 * - `queued`: it is the innermost entry of a wait still in progress on a gate
 *   (`layer`) for at least its threshold — the gate, and whoever holds it,
 *   is the cause.
 */
export type StuckSpanFinding = StuckSpanFindingBase &
  (
    | { cause: "own-work"; ownMs: number }
    | { cause: "queued"; layer: string; waitKind: WaitKind; waitedMs: number }
  );

export type StuckCause = StuckSpanFinding["cause"];

/**
 * Every open span that is stuck right now, keeping only the deepest of a chain.
 *
 * A span is a CANDIDATE when its kind is watched and either
 *
 * - its own time — its age less its waits, the ended ones (`waitMs`) and the
 *   ones still in progress in its subtree (`pendingWaitMs`) — reaches its
 *   kind's threshold (`own-work`), or
 * - a wait it is the innermost entry of has lasted its kind's threshold
 *   (`queued`, on that wait's gate).
 *
 * A wait is charged to the profiler only when it ends, so without the
 * in-progress waits a span queued 90 s on a gate reads as 90 s of its own
 * work: on main (2026-11-04) hundreds of `sub reports.list:rows` and
 * `sub host-fs.peek` runs were filed as stuck themselves while the read gate
 * they waited on, and what held it, went unnamed.
 *
 * A candidate that is an ancestor of another candidate is dropped: an entry
 * waits on its children, so when a `push` is stuck the `flush` above it is
 * stuck *because of* it, and one report naming the push — with the flush in
 * its ancestor chain — says everything two reports would, without the second
 * row. If the child later finishes and the parent is still stuck, the parent
 * is then the deepest candidate and gets its own report.
 *
 * Sorted oldest first.
 */
export function findStuckSpans(
  open: readonly OpenSpan[],
  policy: StuckSpanPolicyTable = STUCK_SPAN_POLICY,
): StuckSpanFinding[] {
  const byId = new Map<number, OpenSpan>();
  for (const s of open) byId.set(s.id, s);

  const candidates: StuckSpanFinding[] = [];
  for (const s of open) {
    const p = policy[s.kind];
    if (!p.watch || s.ageMs < p.thresholdMs) continue;
    const base = {
      id: s.id,
      kind: s.kind,
      label: s.label,
      ageMs: s.ageMs,
      thresholdMs: p.thresholdMs,
      ancestors: ancestorsOf(s, byId),
    };
    // `waiting` is oldest first: the longest wait in progress is the one.
    const wait = s.waiting?.[0];
    if (wait && wait.waitedMs >= p.thresholdMs) {
      candidates.push({
        ...base,
        cause: "queued",
        layer: wait.layer,
        waitKind: wait.kind,
        waitedMs: wait.waitedMs,
      });
      continue;
    }
    const ownMs = s.ageMs - (s.waitMs ?? 0) - (s.pendingWaitMs ?? 0);
    if (ownMs >= p.thresholdMs)
      candidates.push({ ...base, cause: "own-work", ownMs });
  }

  const hasStuckDescendant = new Set<number>();
  for (const c of candidates)
    for (const a of c.ancestors) hasStuckDescendant.add(a.id);

  return candidates
    .filter((c) => !hasStuckDescendant.has(c.id))
    .sort((a, b) => b.ageMs - a.ageMs);
}

// Walk `parentId` up through the open set. The walk stops at the first parent
// that is not open (it closed, or it was never an entry — an orphan edge, which
// the recorder documents as normal) and at any edge that breaks the recorder's
// `parentId < id` invariant, so a corrupt edge can never loop. Since ids strictly
// decrease along the walk, it is bounded by the open set's size.
function ancestorsOf(
  span: OpenSpan,
  byId: ReadonlyMap<number, OpenSpan>,
): StuckAncestorSpan[] {
  const chain: StuckAncestorSpan[] = [];
  let childId = span.id;
  let parentId = span.parentId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (!parent || parent.id >= childId) break;
    chain.push({
      id: parent.id,
      kind: parent.kind,
      label: parent.label,
      ageMs: parent.ageMs,
    });
    childId = parent.id;
    parentId = parent.parentId;
  }
  return chain.reverse();
}

export interface StuckSpanWatcherDeps {
  /** The currently open entry spans — the WHOLE set, since pruning reads it too. */
  readOpen: () => readonly OpenSpan[];
  policy?: StuckSpanPolicyTable;
}

export interface StuckSpanWatcher {
  /**
   * One sample: the findings never handed over before (oldest first), empty
   * when none. Each span run is handed over at most once per cause for its
   * lifetime; the caller files them.
   */
  tick(): readonly StuckSpanFinding[];
  /** Forget every span handed over so far (a restarted watchdog). */
  reset(): void;
  /** How many span ids are remembered right now — bounded by the open set. */
  rememberedCount(): number;
}

/**
 * The stateful half: which span runs have already been handed over, for which
 * cause. Keyed by the recorder's per-run id, never by label — two runs of the
 * same operation that each get stuck are two findings (grouped into one report
 * per tick by the watchdog). A run is handed over once per CAUSE: a sub queued
 * on a gate, then admitted and stuck in its own load, is two findings.
 *
 * BOUNDED by construction: after every tick the remembered set is pruned to the
 * ids still open, so it can never outgrow the open-entry registry (×2 causes).
 * A span that closes is forgotten; its id is never reused (the recorder's
 * counter is process-lifetime), so forgetting it can never cause a re-report.
 */
export function createStuckSpanWatcher(
  deps: StuckSpanWatcherDeps,
): StuckSpanWatcher {
  let remembered = new Map<number, Set<StuckCause>>();

  return {
    tick() {
      const open = deps.readOpen();
      const stuck = findStuckSpans(open, deps.policy);
      const fresh = stuck.filter((f) => !remembered.get(f.id)?.has(f.cause));

      const next = new Map<number, Set<StuckCause>>();
      for (const s of open) {
        const causes = remembered.get(s.id);
        if (causes) next.set(s.id, causes);
      }
      for (const f of fresh) {
        const causes = next.get(f.id) ?? new Set<StuckCause>();
        causes.add(f.cause);
        next.set(f.id, causes);
      }
      remembered = next;

      return fresh;
    },
    reset() {
      remembered = new Map();
    },
    rememberedCount() {
      return remembered.size;
    },
  };
}

// The tick's own-work findings, one per operation (`kind` + `label`): its
// oldest run (findings arrive oldest first) and how many runs were found.
// Runs of one operation stuck at one instant share their cause, so they are
// one report, counting its runs.
export function groupByOperation(
  findings: readonly OwnWorkFinding[],
): { lead: OwnWorkFinding; runs: number }[] {
  const byOp = new Map<string, { lead: OwnWorkFinding; runs: number }>();
  for (const f of findings) {
    const key = `${f.kind} ${f.label}`;
    const g = byOp.get(key);
    if (g) g.runs += 1;
    else byOp.set(key, { lead: f, runs: 1 });
  }
  return [...byOp.values()];
}

export type OwnWorkFinding = Extract<StuckSpanFinding, { cause: "own-work" }>;
export type QueuedFinding = Extract<StuckSpanFinding, { cause: "queued" }>;

/** The operations queued on one gate, each with how many of its runs wait. */
export interface GateWaiters {
  kind: SpanKind;
  label: string;
  runs: number;
}

// The tick's queued findings, one per GATE (`layer`): every run queued on a
// gate at one instant waits for the same thing — the gate's holders — so it
// is one report about the gate, whatever operations wait on it (on main,
// 2026-11-04, `sub reports.list:rows` and `sub host-fs.peek` were filed 387
// and 314 times, each run as stuck itself, all queued on the one read gate).
// The lead is the longest waiter; `waiters` counts the runs per operation,
// most first.
export function groupByGate(findings: readonly QueuedFinding[]): {
  lead: QueuedFinding;
  runs: number;
  waiters: GateWaiters[];
}[] {
  const byGate = new Map<
    string,
    { lead: QueuedFinding; runs: number; ops: Map<string, GateWaiters> }
  >();
  for (const f of findings) {
    let g = byGate.get(f.layer);
    if (!g) {
      g = { lead: f, runs: 0, ops: new Map() };
      byGate.set(f.layer, g);
    }
    g.runs += 1;
    if (f.waitedMs > g.lead.waitedMs) g.lead = f;
    const key = `${f.kind} ${f.label}`;
    const op = g.ops.get(key);
    if (op) op.runs += 1;
    else g.ops.set(key, { kind: f.kind, label: f.label, runs: 1 });
  }
  return [...byGate.values()].map(({ lead, runs, ops }) => ({
    lead,
    runs,
    waiters: [...ops.values()].sort((a, b) => b.runs - a.runs),
  }));
}
