import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import type {
  GrantHooks,
  Lane,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import type { OpKind } from "@plugins/infra/plugins/worktree/core";
import {
  readSleepClock,
  type SleepClockReading,
} from "@plugins/packages/plugins/sleep-clock/core";
import {
  advanceSleeps,
  type OpEvent,
  type OpSleep,
  type OpSleepStamp,
  type OpStep,
  type OpSummary,
  type OpWait,
  type OutcomeByKind,
  type SleepStamp,
  type WaitKind,
  type WaitResult,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import { appendOpLog } from "./jsonl";

// The writer. Emits the v2 change-only event stream (see
// research/2026-09-29-global-unified-op-status.md): one line per state CHANGE —
// `requested`, `wait-start`, `wait-end`, `requeue`, `granted` — and a
// self-contained `completed` summary as the terminal. Nothing is re-stamped: the
// reducer in `../../core` folds the deltas back into one state per op.
//
// Every event carries a per-op `seq` (so re-ingest is idempotent), the wall
// instant `at`, and `t` — monotonic ms since `requested`, the clock every wait
// offset is measured on so a wall-clock step cannot bend a duration — and, when
// the platform has one, `sleep`: the machine's sleep clock at `at`. The writer
// folds those stamps itself (through the reducer's own `advanceSleeps`) and
// puts the sleeps in the summary, and every wait carries its WALL extent
// (`atMs`/`wallMs`) beside its `t` one: `t` pauses while the machine sleeps, so
// only the wall axis puts a wait where it really was.
//
// Every method is a closure, never a `this`-dependent method: the push command
// passes `profiler.markLockRequested`-style bare references around, so a
// `this`-bound method would break at the first call site it is handed to.

/** Identity a caller must supply; the rest is derived by the profiler. */
export interface OpProfilerOptions {
  /**
   * Unique per invocation. push: its `pushId`; build: its `buildId`; check: a
   * fresh uuid (a check has no natural id).
   */
  opId: string;
  branch: string;
  /**
   * `basename(worktree root)` — the op-marker slug, and THE identity of the
   * checkout this op ran in: the liveness key the orphan reconciler probes and
   * the key the profiling reader groups a Gantt row on. Pass
   * `checkoutNamespace(root)` — the caller's own git root.
   */
  opSlug: string | null;
  /** Which reserved-floor lane the op draws from. */
  lane?: Lane | null;
  /** push only. */
  mode?: "worktree" | "from-main";
  /** build only — joins the record to its `build-profile-<id>.json` spans. */
  buildId?: string | null;
  /**
   * Where each event lands. Defaults to appending to the real `OP_LOG_FILE`.
   * Injectable so a test can drive the profiler against an in-memory sink and
   * assert the event stream without touching the user's real log.
   */
  sink?: (event: OpEvent) => void;
  /**
   * The machine's sleep clock. Defaults to `readSleepClock`; injectable so a
   * test can drive naps without sleeping the machine.
   */
  readSleep?: () => SleepClockReading;
}

export interface OpProfiler<K extends OpKind> {
  /**
   * Append the `requested` event. Call once, before the first wait; any other
   * event emits it first if it has not been, so the log always has identity.
   */
  markRequested(): void;
  /**
   * Open a wait on `kind`, with the cause when the writer knows one (the duress
   * latch's trip reason). Carries the current requeue cycle.
   */
  waitStart(kind: WaitKind, reason?: string | null): void;
  /** Close the currently-open wait with how it ended. No-op if none is open. */
  waitEnd(result?: WaitResult): void;
  /** Bracket `fn` as a wait of `kind`: `acquired` on return, `aborted` on throw. */
  wait<T>(kind: WaitKind, fn: () => Promise<T>): Promise<T>;
  /**
   * The op released what it had queued for and goes round again (a build's
   * duress requeue). Bumps the cycle every later wait carries.
   */
  requeue(): void;
  /**
   * Hooks to hand to `withHostGrant({ lane, max, hooks })`. Records the grant
   * queue as a `host-grant` wait. Safe to call per requeue cycle: each acquire
   * produces its OWN wait entry.
   */
  grantHooks(): GrantHooks;
  /** The primary grant is held and work starts: append `granted`. */
  markGranted(): void;
  stepStart(name: string): void;
  stepEnd(name: string): void;
  /**
   * Record a step whose duration and start instant are ALREADY known — the
   * mirror of the build profiler's `pushBuildSpan` (`cli/plugins/op-runtime/cli/profiler.ts`), for
   * a producer that reports a COMPLETED unit of work post-hoc rather than
   * bracketing it live. `checks/core`'s `onCheckDone(id, durationMs, wallStart)`
   * is exactly that shape: it fires after the check has finished, so routing it
   * through `stepStart`/`stepEnd` (which both read `Date.now()` themselves)
   * would stamp `startMs` = the check's END and `durationMs` ≈ 0 — fabricated.
   *
   * `startedAtMs` is a WALL instant (epoch ms, `Date.now()`'s clock) — the same
   * clock as `grantedAt`, `stepStart`/`stepEnd` and the op's whole axis. Steps
   * used to be offset on `performance.now()`, which pauses while the machine
   * sleeps: after a nap every later step sat too early on the wall-clock bar.
   * One clock for every offset; a monotonic caller converts at its call site.
   */
  recordStep(name: string, durationMs: number, startedAtMs: number): void;
  /** Record the terminal outcome. `write()` is what lands it. */
  complete(outcome: OutcomeByKind[K]): void;
  /** Append the self-contained terminal `completed` event. Idempotent. */
  write(): void;
}

/**
 * The open wait, in the writer's own terms: `startT` on the monotonic clock,
 * `startWallMs` the same instant on the wall clock.
 */
interface OpenWaitState {
  kind: WaitKind;
  startT: number;
  startWallMs: number;
  reason: string | null;
  cycle: number;
}

/** A sleep-clock reading as an event stamp, or `undefined` where unsupported. */
function stampOf(reading: SleepClockReading): SleepStamp | undefined {
  if (!reading.supported) return undefined;
  // Whole ms, the grid every other offset is on.
  const asleepMs = Math.round(reading.asleepMs);
  return reading.wakeAtMs === null
    ? { boot: reading.boot, asleepMs }
    : { boot: reading.boot, asleepMs, wakeAtMs: Math.round(reading.wakeAtMs) };
}

export function createOpProfiler<K extends OpKind>(
  kind: K,
  opts: OpProfilerOptions,
): OpProfiler<K> {
  const conversationId = readEnv("CONVERSATION_ID") ?? null;
  const sink = opts.sink ?? ((event: OpEvent) => appendOpLog(event));
  const readSleep = opts.readSleep ?? readSleepClock;

  const requestedAt = new Date();
  const requestedMs = requestedAt.getTime();
  /** The sleep clock at `requestedAt`, stamped on the `requested` event. */
  const requestedSleep = stampOf(readSleep());
  /** The monotonic reading paired with `requestedAt` — `t`'s zero. */
  const requestedPerfMs = performance.now();
  /** Monotonic ms since `requested`, on the integer grid every offset uses. */
  const tNow = (): number =>
    Math.max(0, Math.round(performance.now() - requestedPerfMs));

  let grantedAt: Date | undefined;
  let completedAt: Date | undefined;
  let outcome: OutcomeByKind[K] | undefined;
  let requestedWritten = false;
  let written = false;
  let seq = 0;
  let cycle = 0;

  const waits: OpWait[] = [];
  let openWait: OpenWaitState | null = null;

  // The writer's running sleep fold — the reducer's own rule, over every stamp
  // this profiler emits, so the summary's `sleeps` are what a reader folding
  // the whole stream would get.
  let sleeps: OpSleep[] = [];
  let sleepStamp: OpSleepStamp | null = null;

  const steps: OpStep[] = [];
  const stepStarts = new Map<string, number>();

  // `OpStep.startMs` is an offset from `grantedAt` (see core/internal/types.ts).
  // Before `markGranted` there is no reference instant yet, so the step pins to
  // 0; not clamped otherwise, because a genuinely-negative offset is a real
  // signal. Rounded onto the same integer-ms grid as the waits. Every step
  // instant is wall clock — the same clock as `grantedAt`.
  const stepOffset = (startedAtMs: number): number =>
    grantedAt ? Math.round(startedAtMs - grantedAt.getTime()) : 0;

  const identity = () => ({
    kind,
    opSlug: opts.opSlug,
    branch: opts.branch,
    conversationId,
    lane: opts.lane ?? null,
    mode: opts.mode ?? null,
    buildId: opts.buildId ?? null,
  });

  type Body = OpEvent extends infer E
    ? E extends OpEvent
      ? Omit<E, "v" | "opId" | "seq" | "at" | "t">
      : never
    : never;

  /** Fold a stamp taken at `atMs` into the running sleeps. */
  const foldSleep = (sleep: SleepStamp | undefined, atMs: number): void => {
    if (sleep === undefined) return;
    ({ sleeps, stamp: sleepStamp } = advanceSleeps(
      sleeps,
      sleepStamp,
      sleep,
      atMs,
      requestedMs,
    ));
  };

  const emit = (
    body: Body,
    t: number = tNow(),
    at: Date = new Date(),
    sleep: SleepStamp | undefined = stampOf(readSleep()),
  ): void => {
    seq++;
    foldSleep(sleep, at.getTime());
    sink({
      v: 2,
      opId: opts.opId,
      seq,
      at: at.toISOString(),
      t,
      ...(sleep === undefined ? {} : { sleep }),
      ...body,
    } as OpEvent);
  };

  const markRequested = (): void => {
    if (requestedWritten) return;
    requestedWritten = true;
    emit(
      { e: "requested", ...identity(), pid: process.pid },
      0,
      requestedAt,
      requestedSleep,
    );
  };

  /** Every non-requested event goes through here, so identity always lands first. */
  const emitAfterRequested = (body: Body): void => {
    markRequested();
    emit(body);
  };

  const closeOpenWait = (result: WaitResult): void => {
    if (!openWait) return;
    const open = openWait;
    openWait = null;
    const endT = tNow();
    const closed: OpWait = {
      kind: open.kind,
      startMs: open.startT,
      durationMs: Math.max(0, endT - open.startT),
      reason: open.reason,
      cycle: open.cycle,
      result,
      atMs: open.startWallMs - requestedMs,
      wallMs: Math.max(0, Date.now() - open.startWallMs),
    };
    waits.push(closed);
    emitAfterRequested({
      e: "wait-end",
      wait: closed.kind,
      startMs: closed.startMs,
      durationMs: closed.durationMs,
      result,
      reason: closed.reason,
      cycle: closed.cycle,
    });
  };

  const waitStart = (
    waitKind: WaitKind,
    reason: string | null = null,
  ): void => {
    // An unclosed previous wait would otherwise be lost; close it rather than
    // silently dropping the interval.
    closeOpenWait("aborted");
    openWait = {
      kind: waitKind,
      startT: tNow(),
      startWallMs: Date.now(),
      reason,
      cycle,
    };
    emitAfterRequested({ e: "wait-start", wait: waitKind, reason, cycle });
  };

  const waitEnd = (result: WaitResult = "acquired"): void => {
    closeOpenWait(result);
  };

  return {
    markRequested,
    waitStart,
    waitEnd,

    async wait<T>(waitKind: WaitKind, fn: () => Promise<T>): Promise<T> {
      waitStart(waitKind);
      let result: WaitResult = "aborted";
      try {
        const value = await fn();
        result = "acquired";
        return value;
      } finally {
        waitEnd(result);
      }
    },

    requeue: () => {
      closeOpenWait("aborted");
      cycle++;
      emitAfterRequested({ e: "requeue", cycle, cause: "duress" });
    },

    grantHooks: (): GrantHooks => ({
      // Slow path only: every slot in the lane's window is busy. That is where a
      // real grant queue starts, so that is where the segment opens.
      onWaitStart: () => waitStart("host-grant"),
      onAcquired: (waitMs: number) => {
        if (openWait?.kind === "host-grant") {
          waitEnd("acquired");
          return;
        }
        // Fast path — `onWaitStart` never fired, so `waitMs` is ≈0 by
        // construction. Only record a segment if the pool actually measured one,
        // so the bar is not littered with zero-width noise — and then as ONE
        // self-contained `wait-end`, with no `wait-start` before it.
        if (waitMs <= 0) return;
        const durationMs = Math.round(waitMs);
        const closed: OpWait = {
          kind: "host-grant",
          startMs: Math.max(0, tNow() - durationMs),
          durationMs,
          reason: null,
          cycle,
          result: "acquired",
          atMs: Math.max(0, Date.now() - requestedMs - durationMs),
          wallMs: durationMs,
        };
        waits.push(closed);
        emitAfterRequested({
          e: "wait-end",
          wait: closed.kind,
          startMs: closed.startMs,
          durationMs,
          result: "acquired",
          reason: null,
          cycle,
        });
      },
    }),

    markGranted: () => {
      closeOpenWait("acquired");
      grantedAt = new Date();
      emitAfterRequested({ e: "granted" });
    },

    stepStart: (name: string) => {
      stepStarts.set(name, Date.now());
    },

    stepEnd: (name: string) => {
      const start = stepStarts.get(name);
      if (start == null) return;
      stepStarts.delete(name);
      steps.push({
        name,
        startMs: stepOffset(start),
        durationMs: Date.now() - start,
      });
    },

    recordStep: (name: string, durationMs: number, startedAtMs: number) => {
      steps.push({ name, startMs: stepOffset(startedAtMs), durationMs });
    },

    complete: (o: OutcomeByKind[K]) => {
      completedAt = new Date();
      outcome = o;
    },

    write: () => {
      // Idempotent: the CLI wires this to both the happy path and a
      // `process.on("exit")` guard, so it can genuinely be called twice.
      if (written) return;
      written = true;
      closeOpenWait("aborted");
      markRequested();

      const completed = completedAt ?? new Date();
      // The terminal's own stamp closes the sleep fold BEFORE the summary is
      // built, so a nap between the last event and the end is in `sleeps`.
      const completedSleep = stampOf(readSleep());
      foldSleep(completedSleep, completed.getTime());
      // An op that ended before `markGranted` never held anything: hold is 0.
      const summary: OpSummary = {
        ...identity(),
        pid: process.pid,
        requestedAt: requestedAt.toISOString(),
        grantedAt: grantedAt?.toISOString() ?? null,
        completedAt: completed.toISOString(),
        waits: [...waits],
        holdMs: grantedAt
          ? Math.max(0, completed.getTime() - grantedAt.getTime())
          : 0,
        totalMs: Math.max(0, completed.getTime() - requestedMs),
        outcome: outcome ?? "error",
        interrupted: false,
        steps: [...steps],
        sleeps: [...sleeps],
      };
      // `emit` folds the same stamp again: a zero delta, so a no-op.
      emit(
        { e: "completed", by: "self", summary },
        tNow(),
        completed,
        completedSleep,
      );
    },
  };
}
