import {
  toOpRecord,
  type OpRecord,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import type { SleepNow } from "@plugins/infra/plugins/host/plugins/machine-sleep/core";
import {
  opRowToFoldState,
  opsHistory,
  type OpRow,
} from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import type {
  OpData,
  OpEntry,
  WorktreeGroup,
} from "@plugins/debug/plugins/profiling/plugins/ops/plugins/op-gantt/web";

// The Gantt's projection of stored ops, computed in the browser off the live
// `opsHistory` rows: each row becomes the reducer's read-model record at `now`
// (an open wait clocked to `now`, an in-flight op's span growing with it, and
// — given the machine's `sleepNow` — the nap since its last event counted as
// asleep, never as work), grouped per worktree, with offsets from the earliest
// op's request.

export const FIVE_MINUTES = 5 * 60 * 1000;
export const TWENTY_MINUTES = 20 * 60 * 1000;

/**
 * The size of every Gantt read of `opsHistory` — the collection's own
 * `maxLimit`, read off it so the two cannot drift. Each read is newest first
 * and never taken for the whole history: one that comes back full is drawn
 * and SAYS it may hold older ops (`capped`), rather than passing the newest
 * ones off as everything it asked for.
 */
export const OPS_READ_LIMIT = opsHistory.window.window.maxLimit;

/** `ms` floored to a multiple of `step` — a stable window bound for a subscription tuple. */
export function floorTo(ms: number, step: number): number {
  return Math.floor(ms / step) * step;
}

/** `ms` ceiled to a multiple of `step`. */
export function ceilTo(ms: number, step: number): number {
  return Math.ceil(ms / step) * step;
}

/**
 * The checkout an op ran in: its `opSlug` (the basename of the git root the
 * writing CLI derived), so every kind lands on one row. A line that carried no
 * slug (a foreign writer, or one predating the slug) is filed under its branch,
 * reduced to the bare id (`claude-web/att-x` → `att-x`).
 */
export function worktreeOf(r: {
  opSlug: string | null;
  branch: string;
}): string {
  return r.opSlug ?? (r.branch.split("/").pop() || r.branch);
}

// An op's span is `requestedAt → requestedAt + totalMs` for EVERY kind —
// never `waitMs + holdMs`, which omits every work gap between the waits.
const startMsOf = (r: OpRecord): number => Date.parse(r.requestedAt);
const endMsOf = (r: OpRecord): number => startMsOf(r) + r.totalMs;

/**
 * The stored rows as read-model records at `now` and `sleepNow` (the machine's
 * sleep clock; `null` = unknown, so no live tail sleep), oldest request first.
 */
export function recordsAt(
  rows: readonly OpRow[],
  now: number,
  sleepNow: SleepNow,
): OpRecord[] {
  const out: OpRecord[] = [];
  for (const row of rows) {
    const rec = toOpRecord(opRowToFoldState(row), now, sleepNow);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => startMsOf(a) - startMsOf(b));
}

/** `[min start, max end]` over the records, or null when there are none. */
export function spanOf(
  records: readonly OpRecord[],
): { startMs: number; endMs: number } | null {
  if (records.length === 0) return null;
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const r of records) {
    startMs = Math.min(startMs, startMsOf(r));
    endMs = Math.max(endMs, endMsOf(r));
  }
  return { startMs, endMs };
}

/** Only the records whose span overlaps `[startMs, endMs]`. */
export function overlapping(
  records: readonly OpRecord[],
  startMs: number,
  endMs: number,
): OpRecord[] {
  return records.filter((r) => endMsOf(r) >= startMs && startMsOf(r) <= endMs);
}

/**
 * Records (oldest first) → Gantt rows. Each worktree's label is a human title
 * looked up off its id (the worktree id is the attempt id, so build-only rows,
 * which carry no `conversationId`, still get one); the row's conversationId —
 * its click target — is the first op that carried one.
 */
export function groupOps(
  records: readonly OpRecord[],
  titleBySlug: Readonly<Record<string, string>>,
): OpData {
  const first = records[0];
  if (!first) return { groups: [], totalMs: 0 };
  const originMs = startMsOf(first);

  const byWorktree = new Map<string, OpEntry[]>();
  let totalMs = 0;
  for (const r of records) {
    const wt = worktreeOf(r);
    let ops = byWorktree.get(wt);
    if (!ops) {
      ops = [];
      byWorktree.set(wt, ops);
    }
    ops.push({
      opId: r.opId,
      kind: r.kind,
      startMs: startMsOf(r) - originMs,
      totalMs: r.totalMs,
      waits: r.waits,
      sleeps: r.sleeps,
      holdMs: r.holdMs,
      outcome: r.outcome,
      interrupted: r.interrupted,
      branch: r.branch,
      buildId: r.buildId,
      conversationId: r.conversationId,
      lane: r.lane,
    });
    totalMs = Math.max(totalMs, endMsOf(r) - originMs);
  }

  const groups: WorktreeGroup[] = [];
  for (const [worktree, ops] of byWorktree) {
    groups.push({
      worktree,
      conversationId:
        ops.find((o) => o.conversationId != null)?.conversationId ?? null,
      title: titleBySlug[worktree] ?? null,
      ops,
    });
  }
  return { groups, totalMs };
}
