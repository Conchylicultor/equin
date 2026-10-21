import type { Lane } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import type { OpKind } from "@plugins/infra/plugins/worktree/core";

// The one durable record for every op that competes for a host resource. Before
// this, `push`, `build`, and `check` each hand-rolled their own lifecycle
// logging (or, for `check`, none at all), and the duplication had already caused
// real drift — three independent copies of `PushContentionRecord`, two
// near-identical orphan reconcilers. See
// research/2026-07-17-global-op-log-unified-wait-profiling.md and, for the v2
// event format, research/2026-09-29-global-unified-op-status.md.

// What kind of op a record is: the `OpKind` vocabulary declared ONCE, as data,
// in `infra/worktree/core` — the same type the worktree op marker carries.
// Import it from there; this barrel deliberately does not re-export it.

/**
 * The distinct resources an op can block on, declared once as data (like
 * `OP_KINDS`). Which one an op is parked in IS the diagnosis:
 * `push-mutex` = self-queued behind another push; `build-lock` = queued behind
 * another build in the same worktree; `host-grant` = host CPU starved by the
 * rest of the fleet; `duress-valve` = held out of a storm by the cluster
 * sentinel; `in-flight` = an identical op (same work, same tree) was already
 * running in this worktree, so this one waits for its verdict instead of
 * running again (`withDirectOp`'s flight). Its reason is `<kind> <leaderOpId>`.
 *
 * `sentence(reason)` is the one human wording of "parked here", shared by every
 * surface (banner, chip tooltip, `await` progress) so they cannot disagree.
 */
export const WAIT_KINDS = {
  "push-mutex": {
    label: "Push queue",
    sentence: (_reason: string | null) => "queued behind another push",
  },
  "build-lock": {
    label: "Build lock",
    sentence: (_reason: string | null) =>
      "queued behind another build in this worktree",
  },
  "host-grant": {
    label: "Host CPU",
    sentence: (_reason: string | null) => "waiting for a host CPU grant",
  },
  "duress-valve": {
    label: "Duress valve",
    sentence: (reason: string | null) =>
      `held: host under duress${reason ? ` (${reason})` : ""}`,
  },
  "in-flight": {
    label: "In-flight run",
    sentence: (reason: string | null) =>
      `waiting on in-flight ${reason ?? "identical run"}`,
  },
} as const satisfies Record<string, WaitKindMeta>;

export interface WaitKindMeta {
  label: string;
  sentence: (reason: string | null) => string;
}

export type WaitKind = keyof typeof WAIT_KINDS;

/**
 * How a wait ended. `acquired` — the resource was granted (lock, mutex, host
 * grant, the duress gate held alone); `cleared` — the duress gate admitted the
 * build beside others (the latch cleared); `fail-open` — the old 30-min duress
 * valve gave up holding (kept to read ops recorded before the gate; nothing
 * writes it now); `aborted` — the wait was closed without its resource (the op
 * ended, or a new wait opened over it).
 */
export type WaitResult = "acquired" | "cleared" | "fail-open" | "aborted";

/**
 * The geometry of one blocked interval — all a Gantt segment needs, and all a
 * legacy (pre-v2) line ever carried. `startMs` is relative to the op's
 * `requestedAt`, NOT to the previous wait: an op's waits are interleaved with
 * real work, so segments are painted at their true offsets inside the op's
 * span rather than packed head-to-tail.
 */
export interface OpWaitSpan {
  kind: WaitKind;
  startMs: number;
  durationMs: number;
}

/**
 * One blocked interval, as the READ model sees it: the span plus why and when.
 * Total — a legacy line's wait folds to `reason: null, cycle: 0, result: null`.
 */
export interface OpWait extends OpWaitSpan {
  /** Writer-supplied cause (the duress latch's trip reason), when it has one. */
  reason: string | null;
  /** The requeue cycle this wait belongs to (0 = before any requeue). */
  cycle: number;
  /** How it ended; `null` for a legacy line (which never said). */
  result: WaitResult | null;
  /**
   * The wait on the WALL axis: its start, ms after `requestedAt`, and its wall
   * length. `startMs`/`durationMs` are on the monotonic `t` clock, which pauses
   * while the machine sleeps, so after a nap they sit too early and run too
   * short; these two are where the wait really was. Absent on a legacy line or
   * a headless op's wait (place it by `startMs`, as before).
   */
  atMs?: number;
  wallMs?: number;
}

/**
 * One reading of the machine's sleep clock, stamped on an event: which boot,
 * and how long the machine had been asleep in total since that boot. Two stamps
 * of one boot differ in `asleepMs` by exactly the sleep between them.
 * `wakeAtMs` is the wall instant (epoch ms) of the last wake, when known — it
 * places the most recent of those sleeps exactly.
 */
export interface SleepStamp {
  boot: string;
  asleepMs: number;
  wakeAtMs?: number;
}

/**
 * One interval the machine slept through while the op ran, on the WALL axis:
 * `startMs` is ms after `requestedAt`. `approx` when its position is a guess
 * (pinned to the end of the gap between two events) — its LENGTH is always
 * exact.
 */
export interface OpSleep {
  startMs: number;
  durationMs: number;
  approx: boolean;
}

/**
 * The last sleep stamp a fold saw: the reading plus the wall instant (epoch
 * ms) it was taken at, which is where the next sleep's gap starts.
 */
export interface OpSleepStamp {
  boot: string;
  asleepMs: number;
  atMs: number;
}

/** One named work step, relative to `grantedAt` (mirrors the legacy push steps). */
export interface OpStep {
  name: string;
  startMs: number;
  durationMs: number;
}

/**
 * The terminal outcomes each kind may report. Per-kind because they genuinely
 * differ — only a push can fail its rebase — and keying `createOpProfiler` on
 * this makes `complete("failed_rebase")` a tsc error on a build.
 */
export interface OutcomeByKind {
  build: "success" | "failed" | "error";
  push: "success" | "failed_rebase" | "failed_checks" | "failed_push" | "error";
  check: "success" | "failed" | "error";
  test: "success" | "failed" | "error";
  e2e: "success" | "failed" | "error";
}

/** Any outcome a writer may stamp on a terminal record. */
export type TerminalOutcome = OutcomeByKind[OpKind];

/**
 * A record's outcome as the READER sees it: a writer-stamped terminal, or one of
 * the two synthetic states the fold derives for an op that has not written a
 * terminal record yet.
 */
export type OpOutcome = TerminalOutcome | "waiting" | "running";

/** The wait an op is parked in right now. */
export interface OpenWait {
  kind: WaitKind;
  /** Offset from `requestedAt`, so the closed wait keeps the same `startMs`. */
  startMs: number;
  startedAt: string;
  reason: string | null;
  cycle: number;
}

/** Who wrote an op's terminal line. */
export type OpClosedBy = "self" | "reconciler";

/**
 * Who an op is — everything a writer knows up-front. Carried by the v2
 * `requested` event AND by the terminal summary, so either alone is enough.
 */
export interface OpIdentity {
  kind: OpKind;
  /**
   * `basename(worktree root)` — THE identity of the checkout the op ran in: the
   * op-marker slug, the liveness key the orphan reconciler probes, and the key
   * the profiling reader groups a Gantt row on. Derived from the CLI's own git
   * root, never from an inherited environment.
   */
  opSlug: string | null;
  branch: string;
  conversationId: string | null;
  /** Which reserved-floor lane the op drew from — explains WHY it waited. */
  lane: Lane | null;
  /** push only. */
  mode: "worktree" | "from-main" | null;
  /** build only — joins to `build-profile-<id>.json` for the span breakdown. */
  buildId: string | null;
  /** The CLI process that ran it; `null` on a legacy line. */
  pid: number | null;
}

/**
 * The self-contained terminal: identity, timing, every wait, outcome, steps. A
 * clipped tail that kept only this line still folds to a full record — which is
 * what `await` and the stats readers depend on.
 */
export interface OpSummary extends OpIdentity {
  requestedAt: string;
  /** `null` when the op ended (or was killed) before it was granted. */
  grantedAt: string | null;
  /** `null` for a reconciler close: a killed op has no real end. */
  completedAt: string | null;
  waits: OpWait[];
  holdMs: number;
  totalMs: number;
  outcome: TerminalOutcome;
  /** True for an op hard-killed mid-flight and closed by the reconciler. */
  interrupted: boolean;
  steps: OpStep[];
  /**
   * Every sleep the writer saw — authoritative, since it saw every event.
   * Absent from an older writer's summary (the fold keeps its own then).
   */
  sleeps?: OpSleep[];
}

// ── v2 wire: change-only events ─────────────────────────────────────────────

interface OpEventBase {
  v: 2;
  opId: string;
  /**
   * Per-op sequence number, 1-based and strictly increasing. A non-terminal
   * event applies only when `seq > lastSeq`, which makes re-ingesting the same
   * bytes idempotent.
   */
  seq: number;
  /** Wall-clock instant the event happened. */
  at: string;
  /** Monotonic ms since the op's `requested` (performance.now()-based). */
  t: number;
  /**
   * The machine's sleep clock at `at`. Absent on an older writer's line and on
   * a platform that cannot tell — which means "unknown", never "awake".
   */
  sleep?: SleepStamp;
}

export type OpEvent = OpEventBase &
  (
    | ({ e: "requested"; pid: number } & Omit<OpIdentity, "pid">)
    | { e: "wait-start"; wait: WaitKind; reason: string | null; cycle: number }
    | {
        e: "wait-end";
        wait: WaitKind;
        /** Offset from `requestedAt` — the closed wait's `startMs`. */
        startMs: number;
        durationMs: number;
        result: WaitResult;
        /**
         * Repeated from the `wait-start` so a wait-end is self-contained: the
         * fast-path grant emits one with no `wait-start` at all.
         */
        reason: string | null;
        cycle: number;
      }
    | { e: "requeue"; cycle: number; cause: "duress" }
    | { e: "granted" }
    | { e: "completed"; by: OpClosedBy; summary: OpSummary }
  );

export type OpEventKind = OpEvent["e"];

// ── legacy wire: re-stamped snapshots (pre-v2 CLIs) ─────────────────────────

/** A legacy line's open wait: no reason, no cycle. */
export interface LegacyOpenWait {
  kind: WaitKind;
  startMs: number;
  startedAt: string;
}

/**
 * The LEGACY wire shape — a pre-v2 CLI's snapshot line. Folded until every CLI
 * writing it has exited (Phase 5 of the unified-op-status plan removes it).
 *
 * | phase       | written when                                               |
 * |-------------|------------------------------------------------------------|
 * | `requested` | before the first wait, re-stamped on every wait open/close |
 * | `granted`   | the op stops queuing for its ENTRY ticket                  |
 * | `completed` | terminal, with the accumulated waits + outcome + steps     |
 *
 * Every field but `phase`/`opId` is optional: an older CLI's line must never
 * make the reader throw.
 */
export interface RawOpRecord {
  phase: "requested" | "granted" | "completed";
  opId: string;
  kind?: OpKind;
  opSlug?: string | null;
  branch?: string;
  conversationId?: string | null;
  lane?: Lane | null;
  mode?: "worktree" | "from-main" | null;
  buildId?: string | null;
  requestedAt?: string;
  grantedAt?: string;
  completedAt?: string | null;
  waits?: OpWaitSpan[];
  openWait?: LegacyOpenWait | null;
  holdMs?: number;
  totalMs?: number;
  outcome?: TerminalOutcome;
  interrupted?: boolean;
  steps?: OpStep[];
}

/** Any line in `op-log.jsonl`: a v2 event, or a legacy snapshot. */
export type OpLine = OpEvent | RawOpRecord;

// ── fold state ───────────────────────────────────────────────────────────────

/**
 * One op's folded state — what `applyOpEvent` reduces lines into. Plain JSON
 * data mapping one-to-one onto a DB row, so a store can load a row, apply the
 * next line, and write it back.
 *
 * `identity === null` is a HEADLESS op: its `requested` line was never seen
 * (clipped by a bounded tail read). It renders nothing until a terminal
 * summary brings its identity.
 */
export interface OpFoldState {
  opId: string;
  identity: OpIdentity | null;
  requestedAt: string | null;
  grantedAt: string | null;
  completedAt: string | null;
  /** Closed waits, in order. */
  waits: OpWait[];
  openWait: OpenWait | null;
  /** Current requeue cycle (0 until the first requeue). */
  cycle: number;
  /** Highest v2 `seq` applied; 0 before any. */
  lastSeq: number;
  /** Non-null ⇔ terminal. */
  closedBy: OpClosedBy | null;
  outcome: TerminalOutcome | null;
  interrupted: boolean;
  holdMs: number;
  totalMs: number;
  steps: OpStep[];
  /** Sleeps folded so far, merged, in order. */
  sleeps: OpSleep[];
  /** The last sleep stamp applied; `null` before any (or on a legacy op). */
  sleepStamp: OpSleepStamp | null;
}

/**
 * The READ model: one folded record per op. Total by construction — every field
 * is resolved, so a consumer never re-derives a default. Produced only by
 * `toOpRecord`.
 */
export interface OpRecord {
  opId: string;
  kind: OpKind;
  opSlug: string | null;
  branch: string;
  conversationId: string | null;
  lane: Lane | null;
  mode: "worktree" | "from-main" | null;
  buildId: string | null;
  pid: number | null;
  requestedAt: string;
  grantedAt: string;
  completedAt: string | null;
  /**
   * Every distinct interval this op spent blocked — for an in-flight op, the
   * open wait too, clocked against the reader's `now`. A LIST, not a scalar: an
   * op genuinely blocks on several resources in sequence (build: build-lock →
   * duress-valve → host-grant), and collapsing them to one number is precisely
   * what made build stalls unattributable.
   */
  waits: OpWait[];
  /**
   * DERIVED: time spent blocked, from the one breakdown `liveTimes` uses — the
   * waits' wall extent minus any sleep inside them, clipped to the op's span.
   * `totalMs − waitMs − asleepMs` is the work, exactly.
   */
  waitMs: number;
  /** The wait the op is parked in right now; always `null` once terminal. */
  openWait: OpenWait | null;
  /** Current (or final) requeue cycle. */
  cycle: number;
  holdMs: number;
  totalMs: number;
  outcome: OpOutcome;
  /**
   * True for ops hard-killed mid-flight and closed by the reconciler. They have
   * no real end, so they carry no duration and render as a fixed-width marker.
   */
  interrupted: boolean;
  /** Who closed it; `null` while in flight. */
  closedBy: OpClosedBy | null;
  steps: OpStep[];
  /**
   * Every sleep inside the op's span (wall axis, merged, clipped) — for an
   * in-flight op including the tail since its last event, derived from the
   * reader's `sleepNow`.
   */
  sleeps: OpSleep[];
  /** DERIVED: the union of `sleeps`. Never counted as work. */
  asleepMs: number;
}

/**
 * Waited vs worked vs asleep at `now` — the ONE place these are computed.
 * `waitingMs + workingMs + asleepMs === elapsedMs`, by construction.
 */
export interface OpLiveTimes {
  elapsedMs: number;
  waitingMs: number;
  workingMs: number;
  /** Time the machine slept through, waits included (a nap is never a wait). */
  asleepMs: number;
  /** The open wait's share of `waitingMs` (sleep inside it excluded). */
  openWaitMs: number;
}
