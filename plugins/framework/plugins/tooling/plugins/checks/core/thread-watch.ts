import type {
  StackSample,
  StackSampler,
} from "@plugins/infra/plugins/stack-sampler/core";
import {
  readThreadCpu,
  type ThreadCpuReading,
} from "@plugins/packages/plugins/thread-cpu-clock/core";
import {
  createKindTally,
  createOwnerTally,
  ownerOf,
  repoRoots,
  STALL_LEAVES,
  type KindTally,
  type OwnerShare,
  type OwnerTally,
  type StallKind,
} from "./thread-attribution";

// A check run is ~100 checks on ONE JS thread. In every uncached full pass on
// 2026-09-10/11 the last check started ~1 s in and then nothing settled for
// another 6–14 s, after which ~100 checks settled within ~120 ms of each other.
// A wall-clock timer running in that window measures the process, not what it
// waits on — which is how fork-schema-drift's 5 s connect timed out against a
// healthy Postgres. This watch is the instrument: it records every stretch the
// thread could not run a timer, and from stack samples, WHO held it.
// Design and measured culprits: the wiki track page "Check pass speed"
// (`read_page` block-c0e3f7dd-4943-432d-a631-d864fe623fe7).

/**
 * Tick cadence. Frequent enough that a tick's lateness is a sharp measure of a
 * block, rare enough that the tick itself (a drain and a few attributions) is
 * noise — its cost is reported as `selfMs` on every run, so this claim is
 * checked rather than assumed.
 */
export const TICK_MS = 50;

/**
 * A tick late by at least this much is a stall. 1 s is a fifth of the shortest
 * wall-clock timeout a check has actually failed on (fork-schema-drift's 5 s
 * connect), so anything a timer in a check could notice is counted.
 */
export const STALL_MS = 1_000;

/** Owners a stall keeps in full detail (the transcript's depth). */
const STALL_OWNERS = 5;

/** Owners the whole-run table keeps. */
const RUN_OWNERS = 10;

/** The two in-flight sets the progress run already keeps. */
export interface InFlight {
  running: readonly string[];
  bootstrap: readonly string[];
}

/**
 * ms of process-wide CPU time over some window — `process.cpuUsage()`'s delta,
 * converted from µs. Process-WIDE, not main-thread-only, so a Worker running
 * concurrently in the same process (`type-check`'s own tsc workers) inflates
 * it. Kept for context; the verdict on a stall — did code hold the thread, or
 * did the OS not schedule it — is `StallHeld`, read off the main thread's own
 * CPU clock (`packages/thread-cpu-clock`; Bun itself exposes none).
 */
export interface StallCpu {
  /** ms of USER-mode CPU time over the window. */
  userMs: number;
  /** ms of KERNEL-mode CPU time over the same window — syscall/scheduling
   *  bookkeeping, never the syscall's own wait. */
  systemMs: number;
}

/** `to`'s cpuUsage() minus `from`'s, in ms. Both must be RAW absolute reads
 *  from `process.cpuUsage()` (cumulative since process start), never the
 *  delta form `cpuUsage(prev)` returns — keeping the absolute values as state
 *  is what lets `stepWatch` stay a pure function of its inputs, exactly like
 *  `now`/`samples`, instead of reaching for the clock itself. */
function cpuDelta(from: NodeJS.CpuUsage, to: NodeJS.CpuUsage): StallCpu {
  return {
    userMs: (to.user - from.user) / 1000,
    systemMs: (to.system - from.system) / 1000,
  };
}

function addCpu(a: StallCpu, b: StallCpu): StallCpu {
  return { userMs: a.userMs + b.userMs, systemMs: a.systemMs + b.systemMs };
}

/**
 * The two CPU clocks a tick reads, both RAW absolute values: the process-wide
 * `process.cpuUsage()` and the main thread's own CPU time
 * (`packages/thread-cpu-clock`). Passed in, never read here, so `stepWatch`
 * stays a pure function of its inputs.
 */
export interface WatchClocks {
  process: NodeJS.CpuUsage;
  thread: ThreadCpuReading;
}

/**
 * How much of a stall's `lateMs` the thread was HELD by code, and how much it
 * was STARVED — runnable, but not scheduled. A late tick cannot tell the two
 * apart on its own: an agent's check pass runs at macOS background priority,
 * and on a busy host its tick fires seconds late while the thread ran a fifth
 * of that time (the 2026-10-29 audit: median process CPU ÷ `lateMs` ≈ 0.2). A
 * stall report names code; only the held part is code's doing.
 *
 * - `threadCpuMs`: the main thread's own CPU time over the window — exact, and
 *   no worker inflates it (unlike `cpu`).
 * - `blockedMs`: time inside a synchronous syscall (`readFileSync`,
 *   `spawnSync`…), which holds the thread but accrues no CPU: `lateMs` × the
 *   share of `blocking-io` samples. An estimate from samples, and the only
 *   one: a thread waiting in the kernel looks the same as a starved one to
 *   every clock.
 * - `heldMs = min(lateMs, threadCpuMs + blockedMs)`; `starvedMs` is the rest.
 *
 * `measured: false` where the platform has no thread CPU clock — never read
 * as "nothing held".
 */
export type StallHeld =
  | {
      measured: true;
      threadCpuMs: number;
      blockedMs: number;
      heldMs: number;
      starvedMs: number;
    }
  | { measured: false };

/** The held/starved split of one window — see `StallHeld`. */
export function heldOf(
  lateMs: number,
  threadCpuMs: number | null,
  kinds: Record<StallKind, number>,
): StallHeld {
  if (threadCpuMs === null) return { measured: false };
  const samples = Object.values(kinds).reduce((sum, n) => sum + n, 0);
  const blockedMs =
    samples > 0 ? Math.round((lateMs * kinds["blocking-io"]) / samples) : 0;
  const cpuMs = Math.round(threadCpuMs);
  const heldMs = Math.min(lateMs, cpuMs + blockedMs);
  return {
    measured: true,
    threadCpuMs: cpuMs,
    blockedMs,
    heldMs,
    starvedMs: lateMs - heldMs,
  };
}

/** One stretch where the thread could not run a timer for ≥ `STALL_MS`. */
export interface ThreadStall {
  /**
   * From the watch opening to the tick BEFORE the stall — the last instant the
   * thread was known free, i.e. when the stall began.
   */
  offsetMs: number;
  /** Tick to tick: the window this stall's samples were drained from. */
  durationMs: number;
  /**
   * How late the tick fired (`durationMs − TICK_MS`): the part the thread was
   * KNOWN to be busy. The threshold, the longest, the totals and every overlap
   * are measured on this, never on `durationMs`.
   */
  lateMs: number;
  /**
   * Every check in flight at any point in this stall's window: those running
   * at the previous tick, plus every one that started since. Not the tick's
   * snapshot alone — a check can start and begin blocking in the same turn,
   * before any tick sees it, and a full pass starts ~100 checks in one burst,
   * so the snapshot would come back empty for exactly the stall this exists to
   * explain. The WHOLE list: it is the only link from a `shared` owner — a
   * helper whose caller the sample lost — back to the checks that could have
   * called it.
   */
  running: string[];
  bootstrap: string[];
  samples: number;
  owners: OwnerShare[];
  /** Sample counts by innermost-frame kind — see `classifyLeaf`. */
  kinds: Record<StallKind, number>;
  /** The busiest raw innermost frame names in this stall, busiest first. */
  leaves: Array<{ leaf: string; samples: number }>;
  /** How much of THIS stall's window the process spent on a CPU — see `StallCpu`. */
  cpu: StallCpu;
  /** How much of `lateMs` code held the thread, vs the OS not scheduling it. */
  held: StallHeld;
}

/** The watch's verdict on the run, handed back by `ProgressRun.finish()`. */
export interface ThreadSummary {
  /**
   * The latest any tick fired, stall or not. Written even when nothing stalled:
   * a run whose longest late tick is 300 ms rules out "one long block" as the
   * explanation for slow checks, which is evidence too.
   */
  longestLateMs: number;
  stallCount: number;
  /** Σ `lateMs` over the stalls. */
  stalledMs: number;
  /**
   * Σ `held.heldMs` / `held.starvedMs` over the stalls, and the longest single
   * `heldMs` — null when the platform has no thread CPU clock (see `StallHeld`).
   */
  held: {
    heldMs: number;
    starvedMs: number;
    longestHeldMs: number;
  } | null;
  /** Every sample drained over the run, stall or not. */
  samples: number;
  /**
   * Samples per second, measured inside stall windows only — where the thread
   * is busy by definition. The JSC rate is not fixed (~40 Hz in the planning
   * probe, ~230 Hz in health-monitor), so it is measured, never assumed. Null
   * when no stall carried a sample: there is then nothing to measure it on,
   * and the tables report shares only.
   */
  rateHz: number | null;
  /** Time spent inside the watch's own tick handler — on the thread's own CPU
   *  clock when there is one (see `selfClock`): wall time would also count
   *  every tick the OS preempted, which under background priority made the
   *  watch look like it cost 4–20 s a run. */
  selfMs: number;
  selfClock: "thread-cpu" | "wall";
  /**
   * Who used the thread over the WHOLE run, not only inside stalls. Work that
   * yields between pieces never trips a stall but still uses the thread up —
   * and it is why durations look inflated. `ms` is `samples / rateHz`, null
   * without a rate.
   */
  owners: Array<OwnerShare & { ms: number | null }>;
  /**
   * Sample counts by innermost-frame kind, over the WHOLE run — same split as
   * a stall's own `kinds`, but never narrowed to stall windows: work that
   * yields between pieces never trips a stall, and this is where it still
   * shows up as (say) blocking I/O.
   */
  kinds: Record<StallKind, number>;
  /** The whole run's CPU time — every tick's delta summed, stall or not (same
   *  "whole run, not just stalls" shape as `kinds`/`owners`). */
  cpu: StallCpu;
  /** Who held the thread across every stall window together. */
  stallOwners: OwnerShare[];
  stalls: ThreadStall[];
}

/** The pure state `stepWatch` advances. Nothing here reads a clock. */
export interface WatchState {
  readonly openedAt: number;
  readonly roots: readonly string[];
  lastTickAt: number;
  /**
   * Everything in flight at some point since `lastTickAt`: the sets at that
   * tick, grown by `noteStarted`. A stall's `running` / `bootstrap`.
   */
  window: { running: Set<string>; bootstrap: Set<string> };
  longestLateMs: number;
  stalls: ThreadStall[];
  /** Each stall's known-busy window `[due, fired]`, for `overlapMs`. */
  windows: Array<{ from: number; to: number }>;
  run: OwnerTally;
  kinds: KindTally;
  stalled: OwnerTally;
  stallWindowMs: number;
  selfMs: number;
  /** Absolute `process.cpuUsage()` as of the last tick — the baseline the next
   *  tick's delta is measured from. */
  lastCpuUsage: NodeJS.CpuUsage;
  /** Absolute main-thread CPU ms as of the last tick; null without the clock. */
  lastThreadCpuMs: number | null;
  /** Every tick's cpu delta, summed — `selfMs`'s sibling for CPU instead of
   *  watch overhead. */
  cpuTotal: StallCpu;
}

export function createWatchState(
  openedAt: number,
  roots: readonly string[],
  inFlight: InFlight,
  clocks: WatchClocks,
): WatchState {
  return {
    openedAt,
    roots,
    lastTickAt: openedAt,
    window: windowFrom(inFlight),
    longestLateMs: 0,
    stalls: [],
    windows: [],
    run: createOwnerTally(roots),
    kinds: createKindTally(roots),
    stalled: createOwnerTally(roots),
    stallWindowMs: 0,
    selfMs: 0,
    lastCpuUsage: clocks.process,
    lastThreadCpuMs: clocks.thread.supported ? clocks.thread.ms : null,
    cpuTotal: { userMs: 0, systemMs: 0 },
  };
}

function windowFrom(inFlight: InFlight): WatchState["window"] {
  return {
    running: new Set(inFlight.running),
    bootstrap: new Set(inFlight.bootstrap),
  };
}

/**
 * A check (or bootstrap phase) entered its body. Recorded into the current
 * window so the next stall names it even if no tick ran between its start and
 * the block — see `ThreadStall.running`.
 */
export function noteStarted(
  state: WatchState,
  kind: keyof InFlight,
  id: string,
): void {
  state.window[kind].add(id);
}

/**
 * One tick, as a pure step over `(state, now, samples)`: attribute every
 * drained sample into the whole-run tally, and if this tick fired `STALL_MS`
 * late, close a stall owned by THIS batch — after a block, the late tick gets
 * exactly the samples taken during it, since the previous tick drained the
 * rest (health-monitor relies on the same property).
 *
 * `inFlight` is read at every tick to seed the next window, so the next stall's
 * `running` starts from the set at the last instant the thread was free —
 * including a late tick, which is the moment between two back-to-back blocks —
 * and grows by every `noteStarted` until it closes.
 */
export function stepWatch(
  state: WatchState,
  now: number,
  samples: readonly StackSample[],
  inFlight: () => InFlight,
  clocks: WatchClocks,
): ThreadStall | null {
  const gap = now - state.lastTickAt;
  const lateMs = Math.max(0, gap - TICK_MS);
  state.longestLateMs = Math.max(state.longestLateMs, lateMs);

  const cpu = cpuDelta(state.lastCpuUsage, clocks.process);
  state.cpuTotal = addCpu(state.cpuTotal, cpu);
  state.lastCpuUsage = clocks.process;
  const threadMs = clocks.thread.supported ? clocks.thread.ms : null;
  const threadCpuMs =
    threadMs !== null && state.lastThreadCpuMs !== null
      ? Math.max(0, threadMs - state.lastThreadCpuMs)
      : null;
  state.lastThreadCpuMs = threadMs;

  const batch = lateMs >= STALL_MS ? createOwnerTally(state.roots) : null;
  const kindBatch = lateMs >= STALL_MS ? createKindTally(state.roots) : null;
  for (const sample of samples) {
    const owner = ownerOf(sample.frames, state.roots, sample.activity);
    state.run.add(owner, sample.frames);
    state.kinds.add(sample.frames);
    if (batch && kindBatch) {
      batch.add(owner, sample.frames);
      state.stalled.add(owner, sample.frames);
      kindBatch.add(sample.frames);
    }
  }

  let stall: ThreadStall | null = null;
  if (batch && kindBatch) {
    const roundedLateMs = Math.round(lateMs);
    const kinds = kindBatch.counts();
    stall = {
      offsetMs: Math.round(state.lastTickAt - state.openedAt),
      durationMs: Math.round(gap),
      lateMs: roundedLateMs,
      running: [...state.window.running],
      bootstrap: [...state.window.bootstrap],
      samples: samples.length,
      owners: batch.top(STALL_OWNERS),
      kinds,
      leaves: kindBatch.topLeaves(STALL_LEAVES),
      cpu: {
        userMs: Math.round(cpu.userMs),
        systemMs: Math.round(cpu.systemMs),
      },
      held: heldOf(roundedLateMs, threadCpuMs, kinds),
    };
    state.stalls.push(stall);
    state.windows.push({ from: state.lastTickAt + TICK_MS, to: now });
    state.stallWindowMs += gap;
  }

  state.lastTickAt = now;
  state.window = windowFrom(inFlight());
  return stall;
}

/** Length of `[a, b] ∩ [from, to]`. */
function intersect(
  window: { from: number; to: number },
  from: number,
  to: number,
): number {
  return Math.max(0, Math.min(window.to, to) - Math.max(window.from, from));
}

/**
 * How much of `[from, to]` fell inside stalls: every recorded stall, plus the
 * CURRENT gap once it is already over `STALL_MS`. The second part is not an
 * edge case — a check can settle in the same event-loop turn a block ends,
 * before the late tick has run, and without it that check's `stalledMs` would
 * miss the very stall that inflated it.
 */
export function overlapMs(
  state: WatchState,
  from: number,
  to: number,
  now: number,
): number {
  let total = 0;
  for (const window of state.windows) total += intersect(window, from, to);
  const due = state.lastTickAt + TICK_MS;
  if (now - due >= STALL_MS)
    total += intersect({ from: due, to: now }, from, to);
  return Math.round(total);
}

/** The summary `finish()` hands back — a snapshot, safe to keep. */
export function summarizeWatch(state: WatchState): ThreadSummary {
  const measured = state.stalls.flatMap((stall) =>
    stall.held.measured ? [stall.held] : [],
  );
  const stallSamples = state.stalled.samples;
  const rateHz =
    stallSamples > 0 && state.stallWindowMs > 0
      ? stallSamples / (state.stallWindowMs / 1000)
      : null;
  return {
    longestLateMs: Math.round(state.longestLateMs),
    stallCount: state.stalls.length,
    stalledMs: state.stalls.reduce((sum, stall) => sum + stall.lateMs, 0),
    // The clock is per platform, so either every stall is measured or none is.
    held:
      state.lastThreadCpuMs === null
        ? null
        : {
            heldMs: measured.reduce((sum, h) => sum + h.heldMs, 0),
            starvedMs: measured.reduce((sum, h) => sum + h.starvedMs, 0),
            longestHeldMs: measured.reduce(
              (max, h) => Math.max(max, h.heldMs),
              0,
            ),
          },
    samples: state.run.samples,
    rateHz: rateHz === null ? null : Math.round(rateHz * 10) / 10,
    selfMs: Math.round(state.selfMs),
    selfClock: state.lastThreadCpuMs === null ? "wall" : "thread-cpu",
    owners: state.run.top(RUN_OWNERS).map((share) => ({
      ...share,
      ms: rateHz === null ? null : Math.round((share.samples / rateHz) * 1000),
    })),
    kinds: state.kinds.counts(),
    cpu: {
      userMs: Math.round(state.cpuTotal.userMs),
      systemMs: Math.round(state.cpuTotal.systemMs),
    },
    stallOwners: state.stalled.top(STALL_OWNERS),
    stalls: [...state.stalls],
  };
}

function readClocks(): WatchClocks {
  return { process: process.cpuUsage(), thread: readThreadCpu() };
}

/** A live watch: the overlap query `checkEnded` asks, and the stop `finish()` calls. */
export interface ThreadWatch {
  overlapMs(from: number, to: number): number;
  /** A check or bootstrap phase started — see `noteStarted`. */
  noteStarted(kind: keyof InFlight, id: string): void;
  /**
   * Stop the timer, run one last tick (so a block that ends the run is still
   * counted, and still reaches `onStall` before the summary is written), and
   * return the summary. A second call returns the same summary.
   */
  stop(): ThreadSummary;
}

/**
 * Open the watch: the thin timer + sampler shell around `stepWatch`.
 *
 * Its lifetime is the progress run's (`openProgressRun` opens it, `finish()`
 * stops it), so it covers bootstrap too — `load-checks` alone takes ~2.5 s —
 * and the runner holds no second handle to forget at one of its early exits.
 *
 * `sampler` is a parameter, not claimed here: the progress run claims the
 * process's one JSC sampler, and a test hands in a fake. `roots` defaults to
 * the repo's; a probe outside the checkout passes its own.
 */
export function openThreadWatch(args: {
  /** The run's own `performance.now()` start — every `offsetMs` counts from it. */
  startedAt: number;
  inFlight: () => InFlight;
  onStall: (stall: ThreadStall) => void;
  sampler: StackSampler;
  roots?: readonly string[];
}): ThreadWatch {
  const { sampler } = args;
  // The sampler cannot be stopped, so anything left in its buffer predates this
  // run; drained now, it is never mistaken for this run's first batch.
  sampler.drain();
  const state = createWatchState(
    args.startedAt,
    args.roots ?? repoRoots(),
    args.inFlight(),
    readClocks(),
  );

  const tick = (): void => {
    const startedAt = performance.now();
    const clocks = readClocks();
    const stall = stepWatch(
      state,
      startedAt,
      sampler.drain(),
      args.inFlight,
      clocks,
    );
    if (stall) args.onStall(stall);
    // On the thread's own clock when there is one: preemption mid-tick is the
    // OS's time, not the watch's cost.
    const end = clocks.thread.supported ? readThreadCpu() : null;
    state.selfMs +=
      clocks.thread.supported && end?.supported
        ? end.ms - clocks.thread.ms
        : performance.now() - startedAt;
  };

  // `.unref()` for the heartbeat's reason: this timer exists to observe the
  // run, never to be why the process stays alive.
  const timer = setInterval(tick, TICK_MS);
  timer.unref();

  let summary: ThreadSummary | null = null;
  return {
    overlapMs: (from, to) => overlapMs(state, from, to, performance.now()),
    noteStarted: (kind, id) => noteStarted(state, kind, id),
    stop() {
      if (summary) return summary;
      clearInterval(timer);
      tick();
      summary = summarizeWatch(state);
      return summary;
    },
  };
}
