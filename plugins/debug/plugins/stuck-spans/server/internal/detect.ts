import type {
  FlightSpan,
  SpanKind,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { STUCK_SPAN_POLICY, type StuckSpanPolicyTable } from "./policy";

// The detector, kept free of the recorder, the trace engine and the reports
// engine: it reads open spans from an injected source and hands new findings to
// an injected sink. `watchdog.ts` wires the real ones; the tests wire fakes and
// drive the clock through the spans' own `ageMs`.

/** The fields of an open flight-window span the detector reads. */
export type OpenSpan = Pick<
  FlightSpan,
  "id" | "parentId" | "kind" | "label" | "ageMs"
>;

export interface StuckAncestorSpan {
  id: number;
  kind: SpanKind;
  label: string;
  ageMs: number;
}

export interface StuckSpanFinding {
  id: number;
  kind: SpanKind;
  label: string;
  ageMs: number;
  thresholdMs: number;
  /** Still-open ancestors, OUTERMOST first, ending at the immediate parent. */
  ancestors: StuckAncestorSpan[];
}

/**
 * Every open span that is stuck right now, keeping only the deepest of a chain.
 *
 * A span is a CANDIDATE when its kind is watched and it has been open at least
 * its kind's threshold. A candidate that is an ancestor of another candidate is
 * dropped: an entry waits on its children, so when a `push` is stuck the `flush`
 * above it is stuck *because of* it, and one report naming the push — with the
 * flush in its ancestor chain — says everything two reports would, without the
 * second row. If the child later finishes and the parent is still stuck, the
 * parent is then the deepest candidate and gets its own report.
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
    candidates.push({
      id: s.id,
      kind: s.kind,
      label: s.label,
      ageMs: s.ageMs,
      thresholdMs: p.thresholdMs,
      ancestors: ancestorsOf(s, byId),
    });
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
  /**
   * Called at most once per tick, only with findings never handed over before
   * (oldest first). Each span run is handed over exactly once for its lifetime.
   */
  onStuck: (findings: readonly StuckSpanFinding[]) => void;
  policy?: StuckSpanPolicyTable;
}

export interface StuckSpanWatcher {
  /** One sample. Returns the findings it handed to `onStuck` (empty when none). */
  tick(): readonly StuckSpanFinding[];
  /** Forget every span handed over so far (a restarted watchdog). */
  reset(): void;
  /** How many span ids are remembered right now — bounded by the open set. */
  rememberedCount(): number;
}

/**
 * The stateful half: which span runs have already been handed over. Keyed by the
 * recorder's per-run id, never by label — two runs of the same operation that
 * each get stuck are two findings (the report engine dedupes them onto one row
 * by label and counts them).
 *
 * BOUNDED by construction: after every tick the remembered set is pruned to the
 * ids still open, so it can never outgrow the open-entry registry. A span that
 * closes is forgotten; its id is never reused (the recorder's counter is
 * process-lifetime), so forgetting it can never cause a re-report.
 */
export function createStuckSpanWatcher(
  deps: StuckSpanWatcherDeps,
): StuckSpanWatcher {
  let remembered = new Set<number>();

  return {
    tick() {
      const open = deps.readOpen();
      const stuck = findStuckSpans(open, deps.policy);
      const fresh = stuck.filter((f) => !remembered.has(f.id));

      const next = new Set<number>();
      for (const s of open) if (remembered.has(s.id)) next.add(s.id);
      for (const f of fresh) next.add(f.id);
      remembered = next;

      if (fresh.length > 0) deps.onStuck(fresh);
      return fresh;
    },
    reset() {
      remembered = new Set();
    },
    rememberedCount() {
      return remembered.size;
    },
  };
}

// The tick's findings, one per operation (`kind` + `label`): its oldest run
// (findings arrive oldest first) and how many runs were found. Runs of one
// operation stuck at one instant share their cause — on main (2026-11-04)
// `sub reports.list:rows` was filed 387 times, many runs per tick, every run
// queued behind the same blocked read gate — so they are one report, counting
// its runs.
export function groupByOperation(
  findings: readonly StuckSpanFinding[],
): { lead: StuckSpanFinding; runs: number }[] {
  const byOp = new Map<string, { lead: StuckSpanFinding; runs: number }>();
  for (const f of findings) {
    const key = `${f.kind} ${f.label}`;
    const g = byOp.get(key);
    if (g) g.runs += 1;
    else byOp.set(key, { lead: f, runs: 1 });
  }
  return [...byOp.values()];
}
