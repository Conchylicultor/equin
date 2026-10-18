import {
  WAIT_KINDS,
  liveTimes,
  type OpLiveTimes,
  type WaitKind,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import {
  opRowToFoldState,
  type OpRow,
} from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import type { OpRowPhase } from "../../core";
import type { SleepNow } from "@plugins/infra/plugins/host/plugins/machine-sleep/core";
import { OP_KINDS, type OpKind } from "@plugins/infra/plugins/worktree/core";
import { formatElapsed } from "@plugins/primitives/plugins/relative-time/web";

// The pure half of the banner, the queue and the chip: which op a worktree
// shows, how its state reads, and how the global push queue orders. Every
// surface renders these same strings, so they cannot disagree.

/**
 * A worktree's slug: the basename of its checkout path — what the op log files
 * an op under (`opSlug`). Derived by hand: no node:path in the browser.
 */
export function slugOf(worktreePath: string): string {
  const parts = worktreePath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? worktreePath;
}

/**
 * The worktree an op ran in. `opSlug`, or — for a legacy line that carried none
 * — the last segment of its branch (`claude-web/att-x` → `att-x`), which is the
 * same id by the basename invariant.
 */
export function opSlugOf(row: OpRow): string {
  return row.opSlug ?? slugOf(row.branch);
}

// Which op a worktree shows when it somehow has several in flight: a push
// (global-lock-contended, highest stakes) outranks a check, which outranks a
// build; a test or an e2e run contends for the host grant only and yields the
// display slot. `Record<OpKind, …>` keeps it complete: a kind without a rank is
// a type error.
const OP_RANK: Record<OpKind, number> = {
  push: 4,
  check: 3,
  build: 2,
  test: 1,
  e2e: 1,
};

/** The worktree's in-flight ops, the one it shows first (by `OP_RANK`, then oldest). */
export function opsOfSlug(rows: readonly OpRow[], slug: string): OpRow[] {
  return rows
    .filter((r) => opSlugOf(r) === slug)
    .sort(
      (a, b) =>
        OP_RANK[b.kind] - OP_RANK[a.kind] ||
        a.requestedAt.getTime() - b.requestedAt.getTime(),
    );
}

/**
 * Waited vs worked vs asleep at `now`, off the reducer's one derivation.
 * `sleepNow` is the machine's sleep clock (`useSleepNowForFold`; `null` =
 * unknown): with it, a nap since the op's last event is asleep, never worked.
 */
export function timesOf(
  row: OpRow,
  now: number,
  sleepNow: SleepNow,
): OpLiveTimes {
  return liveTimes(opRowToFoldState(row), now, sleepNow);
}

/**
 * The one state line: `Build — held: host under duress (loadRatio) · requeue #6
 * · 12:03` while parked in a wait (the clock is that wait's own, a nap inside
 * it excluded), `Build — Building` while working.
 */
export function stateLine(row: OpRow, now: number, sleepNow: SleepNow): string {
  const { label, progressive } = OP_KINDS[row.kind];
  const wait = row.openWait;
  if (!wait) return `${label} — ${progressive}`;
  const requeue = wait.cycle > 0 ? ` · requeue #${wait.cycle}` : "";
  const clock = formatElapsed(timesOf(row, now, sleepNow).openWaitMs);
  return `${label} — ${WAIT_KINDS[wait.kind].sentence(wait.reason)}${requeue} · ${clock}`;
}

/**
 * How a row of the expanded list reads at a glance. `queued` is waiting its
 * turn in an ordinary line (the push mutex, the build lock, the host grant) —
 * the expected case, told by the glyph alone. `held` is a wait nobody queues
 * for (the duress valve) and says so in words. `Record<WaitKind, …>` keeps it
 * complete: a new wait kind is a type error until it is classified.
 */
export type RowPhase = OpRowPhase;

const WAIT_PHASE: Record<WaitKind, RowPhase> = {
  "push-mutex": "queued",
  "build-lock": "queued",
  "host-grant": "queued",
  "duress-valve": "held",
  // Waiting on an identical run's verdict is waiting in an ordinary line.
  "in-flight": "queued",
};

export function phaseOf(row: OpRow): RowPhase {
  return row.openWait ? WAIT_PHASE[row.openWait.kind] : "working";
}

/** One row of the expanded list. `queuePos` is the 1-based global push-queue position. */
export interface QueueRow {
  row: OpRow;
  slug: string;
  queuePos: number | null;
  isSelf: boolean;
}

/** One section of the expanded list: every in-flight op of one kind. */
export interface OpSection {
  kind: OpKind;
  /** `Push queue` for pushes (the one global queue), else the kind's label. */
  title: string;
  rows: QueueRow[];
}

const byTime =
  (at: (r: OpRow) => number) =>
  (a: OpRow, b: OpRow): number =>
    at(a) - at(b);
const requestedMs = (r: OpRow) => r.requestedAt.getTime();

const PHASE_RANK: Record<RowPhase, number> = { working: 0, held: 1, queued: 2 };

/**
 * The global push queue, in order: `#1` the push that holds the mutex
 * (granted), then the pushes parked on the mutex in the order they joined it,
 * then any push not yet at the mutex.
 */
function pushQueue(pushes: readonly OpRow[]): OpRow[] {
  const holders = pushes
    .filter((r) => r.grantedAt !== null)
    .sort(byTime((r) => r.grantedAt?.getTime() ?? 0));
  const ungranted = pushes.filter((r) => r.grantedAt === null);
  const onMutex = ungranted
    .filter((r) => r.openWait?.kind === "push-mutex")
    .sort(byTime((r) => Date.parse(r.openWait?.startedAt ?? "")));
  const beforeMutex = ungranted
    .filter((r) => r.openWait?.kind !== "push-mutex")
    .sort(byTime(requestedMs));
  return [...holders, ...onMutex, ...beforeMutex];
}

/**
 * Every in-flight op, one section per kind: the section holding this
 * worktree's own op first, then the rest in `OP_KINDS` order. Pushes keep their
 * global queue order and positions; every other kind (which serializes per
 * worktree or on the host grant, with no global position) reads working → held
 * → queued, then by request time — the order they will run in.
 */
export function buildSections(
  rows: readonly OpRow[],
  selfSlug: string,
): OpSection[] {
  const toRow = (row: OpRow, queuePos: number | null): QueueRow => {
    const slug = opSlugOf(row);
    return { row, slug, queuePos, isSelf: slug === selfSlug };
  };
  const sections: OpSection[] = [];
  for (const kind of Object.keys(OP_KINDS) as OpKind[]) {
    const ofKind = rows.filter((r) => r.kind === kind);
    if (ofKind.length === 0) continue;
    const ordered =
      kind === "push"
        ? pushQueue(ofKind).map((r, i) => toRow(r, i + 1))
        : [...ofKind]
            .sort(
              (a, b) =>
                PHASE_RANK[phaseOf(a)] - PHASE_RANK[phaseOf(b)] ||
                requestedMs(a) - requestedMs(b),
            )
            .map((r) => toRow(r, null));
    sections.push({
      kind,
      title: kind === "push" ? "Push queue" : OP_KINDS[kind].label,
      rows: ordered,
    });
  }
  const selfAt = sections.findIndex((s) => s.rows.some((r) => r.isSelf));
  if (selfAt > 0) sections.unshift(...sections.splice(selfAt, 1));
  return sections;
}
