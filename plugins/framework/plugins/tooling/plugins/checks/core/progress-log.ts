import { basename } from "path";
import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import {
  claimStackSampler,
  type StackSampler,
} from "@plugins/infra/plugins/stack-sampler/core";
import {
  fileReportFromProcess,
  mergeBaseWithMain,
} from "@plugins/reports/plugins/outbox/core";
import { checkProgressLogDir } from "../data-dirs";
import { openStallReporter, type StallReportSink } from "./stall-report";
import type { OwnerShare, StallKind } from "./thread-attribution";
import {
  openThreadWatch,
  type StallCpu,
  type ThreadStall,
  type ThreadSummary,
} from "./thread-watch";

// Host-global, exactly like the check-result cache next door (cache.ts:18) —
// every worktree's check run appends to the SAME file, which is the point: an
// incident is investigated from whichever shell is free, not from the wedged
// worktree. `runId` + `pid` + `worktree` on every line keep the runs separable.
const PROGRESS_FILE = checkProgressLogDir.file("check-progress.jsonl");

/**
 * The bound, explicit rather than defaulted. `defineFileSink`'s defaults are
 * 128 MB × 3 — a firehose budget sized for the live-state log channel, absurd for
 * a file where a FULL check run is ~155 lines. 2 MB × keep 2 is 6 MB worst case,
 * versus the ~5 MB the old hand-rolled `prune()` allowed — and it retains ~8,000
 * lines against that implementation's 2,000, i.e. dozens of runs of real history
 * rather than a handful.
 *
 * Note the shape difference this trades on: rotation cannot trim *within* a file
 * the way `prune()`'s rewrite could, so history is bought back with `keep`, not
 * with a bigger live cap. Rotated slots (`.1`, `.2`) are cold but readable —
 * `readCheckProgress` opts into stitching them, which is why `keep` matters here
 * and would be dead weight for a pure tail reader.
 *
 * `file:check-progress` shows up in `getFileSinks()` only in processes that
 * actually evaluate this module — the CLI check runner — and NOT in the server
 * where `retention` assembles growth bounds. That is fine, not a gap: the bound is
 * true by construction (`append()` IS the rotation), and the registry is a
 * per-process set feeding the deferred undeclared-growth monitor, not the thing
 * that makes the file bounded.
 */
const progressSink = defineFileSink({
  id: "check-progress",
  description:
    "Per-check-run progress log (`./singularity check`): one JSONL line per run " +
    "open, bootstrap phase, check start/end, heartbeat, thread stall, and " +
    "completion — so a wedged run names the unit it is stuck in, and a stalled " +
    "one the code that stalled it. Host-global across worktrees.",
  path: PROGRESS_FILE,
  maxBytes: 2 * 1024 * 1024,
  keep: 2,
});

/** Heartbeat cadence: frequent enough to time a hang, rare enough to be free. */
const HEARTBEAT_MS = 30_000;

interface RecordBase {
  t: string;
  runId: string;
  pid: number;
  worktree: string;
}

/**
 * `run` carries only what is knowable BEFORE any work — see `openProgressRun`.
 * The facts that cost a git spawn to learn (`treeHash`) or a module load to
 * resolve (`selected`) arrive later, on a `selected` record keyed by the same
 * `runId`. Splitting them is the whole point: a run that hangs in bootstrap
 * never learns them, and must still have announced itself.
 */
export type ProgressRecord =
  | (RecordBase & {
      phase: "run";
      scope: string | null;
      requested: string[] | null;
    })
  | (RecordBase & { phase: "bootstrap-start"; step: string })
  | (RecordBase & { phase: "bootstrap-end"; step: string; durationMs: number })
  | (RecordBase & {
      phase: "selected";
      treeHash: string | null;
      selected: string[];
    })
  | (RecordBase & { phase: "start"; checkId: string })
  | (RecordBase & {
      phase: "end";
      checkId: string;
      durationMs: number;
      ok: boolean;
      cached: boolean;
      /**
       * Milliseconds this check spent waiting for a slot in the runner's
       * concurrency gate, before its body started. Recorded BESIDE `durationMs`
       * rather than inside it, which is the whole reason the gate is worth
       * having: with an unbounded fan-out every recorded duration was mostly
       * the wave's own length, so twelve unrelated checks all "cost" 260s. A
       * reader that wants the check's share of the wall clock adds the two; a
       * reader that wants its COST reads `durationMs` alone and now gets an
       * answer that means something.
       *
       * OPTIONAL on the wire, required on `checkEnded` — this is a durable log
       * that predates the gate, so the rotations still on disk hold `end` lines
       * without the field. Every line THIS code writes has it. The reader
       * normalizes a missing one to 0, which is not a stand-in for an unknown:
       * a pre-gate run had no queue, so 0 is that run's true wait.
       */
      queuedMs?: number;
      /**
       * Milliseconds of this check's body that fell inside thread stalls
       * (`thread-watch.ts`): the part of `durationMs` that was the process, not
       * the check. OPTIONAL on the wire for the same reason as `queuedMs`, but
       * read back the OPPOSITE way — a missing value is `null`, never 0. A
       * pre-gate run truly had no queue; a pre-watch run DID stall, nobody
       * measured it, and a 0 would claim its durations were clean.
       */
      stalledMs?: number;
      /**
       * The run whose verdict this check adopted (it joined that run's
       * in-flight check). Absent when this run decided it itself — and on
       * every line written before the check-level flight existed.
       */
      sharedFrom?: string;
    })
  /**
   * A started check found the same check (same signature, same tree) in flight
   * in another run and is WAITING on it rather than running (`check-flight.ts`).
   * `leaderId`: that run's id, or null for a leader that had not recorded
   * itself yet. The wait is a phase of the check, not a hang: `--status` names
   * the run it is blocked on.
   */
  | (RecordBase & {
      phase: "joined";
      checkId: string;
      leaderId: string | null;
    })
  /**
   * The wait above ended. `adopted`: the leader's verdict was taken (an `end`
   * follows); otherwise the check runs itself — it is running again.
   */
  | (RecordBase & { phase: "join-ended"; checkId: string; adopted: boolean })
  | (RecordBase & {
      phase: "pending";
      elapsedMs: number;
      pending: string[];
      bootstrap: string[];
      /**
       * Of `pending`, the checks waiting on another run's flight rather than
       * running. Optional on the wire: lines written before the flight existed
       * carry none, and none of their checks could be waiting.
       */
      joined?: string[];
    })
  | (RecordBase & { phase: "stall" } & ProgressStall)
  | (RecordBase & { phase: "thread" } & ProgressThread)
  | (RecordBase & { phase: "done"; elapsedMs: number; allOk: boolean });

/** An owner as a record carries it; `detail` is empty for all but `import`. */
interface RecordOwner {
  owner: string;
  samples: number;
  detail: { name: string; samples: number }[];
}

/**
 * One thread stall, as this file carries it — the TOP 3 owners, each with the
 * first 5 frames of one real stack, and the WHOLE `running` list (the link from
 * a `shared` owner to the checks that could have called it). The transcript
 * gets the full detail (5 owners, 8 frames); this file is host-global and
 * sized for dozens of runs, so it gets what names a culprit and no more.
 *
 * Spelled out rather than derived from `ThreadStall`: this is a wire format
 * that outlives the code writing it, so a field added to the in-memory shape
 * must not reach the file without someone deciding it should.
 */
export interface ProgressStall {
  offsetMs: number;
  durationMs: number;
  lateMs: number;
  running: string[];
  bootstrap: string[];
  samples: number;
  owners: Array<RecordOwner & { example: string[] }>;
  /**
   * Sample counts by innermost-frame kind (blocking-io/process/module-load/cpu/
   * native — see `classifyLeaf`). OPTIONAL on the wire for the same reason as
   * `queuedMs`/`stalledMs`: rotated lines written before this landed have none.
   * Read back, a missing value is `null` (`CheckRunProgress.stalls[].kinds`),
   * never zeros — that stall's split just isn't known.
   */
  kinds?: Record<StallKind, number>;
  /** The busiest raw innermost frame names in this stall, busiest first — same
   *  optionality and normalization as `kinds`. */
  leaves?: Array<{ leaf: string; samples: number }>;
  /** How much of the stall's window the process spent on a CPU — see `StallCpu`.
   *  OPTIONAL on the wire, same reason and same null-not-zero normalization. */
  cpu?: StallCpu;
}

/**
 * The run's thread summary, written ONCE by `finish()`, just before `done` —
 * and even when nothing stalled: `longestLateMs = 300` is evidence too, it
 * rules out the "one long block" explanation. Owners carry no example stack
 * here; the stall records already hold the stacks that matter.
 *
 * `stallOwners` is who held the thread across every stall window together —
 * what the console's "mostly X" ranks. `owners` is the whole run, stall or not.
 */
export interface ProgressThread {
  longestLateMs: number;
  stallCount: number;
  stalledMs: number;
  samples: number;
  rateHz: number | null;
  selfMs: number;
  owners: Array<RecordOwner & { ms: number | null }>;
  /** Sample counts by innermost-frame kind, over the whole run. Same
   *  optionality and normalization as the `stall` record's `kinds`. */
  kinds?: Record<StallKind, number>;
  /** The whole run's CPU time. Same optionality and normalization as the
   *  `stall` record's `cpu`. */
  cpu?: StallCpu;
  stallOwners: RecordOwner[];
}

const STALL_RECORD_OWNERS = 3;
const STALL_RECORD_FRAMES = 5;

function recordOwner(share: OwnerShare): RecordOwner {
  return { owner: share.owner, samples: share.samples, detail: share.detail };
}

function stallRecord(stall: ThreadStall): ProgressStall {
  return {
    offsetMs: stall.offsetMs,
    durationMs: stall.durationMs,
    lateMs: stall.lateMs,
    running: stall.running,
    bootstrap: stall.bootstrap,
    samples: stall.samples,
    owners: stall.owners.slice(0, STALL_RECORD_OWNERS).map((share) => ({
      ...recordOwner(share),
      example: share.example.slice(0, STALL_RECORD_FRAMES),
    })),
    kinds: stall.kinds,
    leaves: stall.leaves,
    cpu: stall.cpu,
  };
}

function threadRecord(summary: ThreadSummary): ProgressThread {
  return {
    longestLateMs: summary.longestLateMs,
    stallCount: summary.stallCount,
    stalledMs: summary.stalledMs,
    samples: summary.samples,
    rateHz: summary.rateHz,
    selfMs: summary.selfMs,
    owners: summary.owners.map((share) => ({
      ...recordOwner(share),
      ms: share.ms,
    })),
    kinds: summary.kinds,
    cpu: summary.cpu,
    stallOwners: summary.stallOwners.map(recordOwner),
  };
}

/**
 * The checkout this run is checking — which is the run's identity, since a check
 * run's whole subject is the tree it was loaded from. That makes `REPO_ROOT` the
 * right source and the other two candidates wrong: `cwd` moves during the
 * build's codegen, and this process's RUNTIME namespace is deliberately declared
 * as a dummy ("barrel-import-stub") by the barrel-import stubs the build loads
 * through (barrel-import/core/internal/stubs.ts), in the SAME process that then
 * runs checks in-process — so a build's check run would misattribute itself to a
 * worktree that isn't real. `REPO_ROOT` is derived from `import.meta.dir` at
 * module load, so it names the checkout this code was read from in every path.
 */
function worktreeName(): string {
  return basename(REPO_ROOT);
}

/**
 * Append one record through the sink. Every property this log depends on survives
 * the move: `FileSink.append` is a single SYNCHRONOUS, unbuffered `appendFileSync`
 * (`file-sink/core/internal/file-sink.ts:appendLines`), which matters because both
 * real incidents ended in a hard kill — a record that is merely *queued* when the
 * signal lands is a record we never see. That one `O_APPEND` write, well under
 * 4KB, is atomic on macOS, so concurrent worktrees interleave whole lines rather
 * than corrupting each other.
 *
 * Write failures still propagate: the only errors `append` swallows are `ENOENT`
 * on the rotation renames (a slot that does not exist yet) and one `ENOENT` on
 * the write itself, which it answers by creating the parent dir and retrying
 * once — a second `ENOENT` throws. A full disk failing check runs loudly is the
 * better trade against silently losing the one diagnostic this file exists to
 * provide.
 */
function appendToSink(record: ProgressRecord): void {
  progressSink.append(JSON.stringify(record));
}

/** A live run's handle: the record writers plus the heartbeat's stop. */
export interface ProgressRun {
  /**
   * This run's id: the caller's (`ProgressRunArgs.runId`) or a minted one. The
   * id a joined check in another run prints as `shared with run <id>`.
   */
  readonly runId: string;
  /**
   * Wrap one bootstrap phase (loading the checks, `git rev-parse`, the tree
   * hash, the cache, the tree snapshot). Every one of these can spawn git and
   * therefore hang, and each one that hangs must name ITSELF — a bootstrap hang
   * used to be indistinguishable from a run that never started at all.
   */
  bootstrap<T>(step: string, fn: () => T | Promise<T>): Promise<T>;
  /**
   * The facts bootstrap had to run to learn. Emitted as a follow-up record so
   * the `run` record itself can be written before any of that work begins.
   */
  resolved(treeHash: string | null, selected: string[]): void;
  /** Record a check entering its body. Written BEFORE the body runs. */
  checkStarted(checkId: string): void;
  /**
   * Record a check settling. Written from a `finally`, so a throw still lands.
   *
   * `queuedMs` is the time spent waiting for a slot in the runner's concurrency
   * gate — separate from `durationMs` on purpose, so a bounded run's per-check
   * cost is never inflated by the queue in front of it. The record's
   * `stalledMs` is not a parameter: the run owns the thread watch, so it asks
   * the watch itself, over the `durationMs` window ending now.
   */
  checkEnded(
    checkId: string,
    durationMs: number,
    ok: boolean,
    cached: boolean,
    queuedMs: number,
    sharedFrom: string | null,
  ): void;
  /**
   * A started check is waiting on another run's in-flight check
   * (`leaderId`, or null for a leader not recorded yet). It leaves the
   * running set for the wait: it is not on the thread, so a stall's `running`
   * list must not name it.
   */
  checkJoined(checkId: string, leaderId: string | null): void;
  /** The wait ended; `adopted: false` puts the check back in the running set. */
  checkJoinEnded(checkId: string, adopted: boolean): void;
  /**
   * Stop the heartbeat and the thread watch, write the `thread` record and then
   * the terminal `done`, and return the thread summary — the runner hands it to
   * the transcript and the console, so it never holds a watch handle of its own.
   */
  finish(allOk: boolean): ThreadSummary;
  /**
   * Resolves once every stall report this run started filing has been written
   * (see `stall-report.ts`). Never rejects. The runner awaits it before
   * returning, because its caller may `process.exit()` next — and an outbox
   * write still in flight then is a report lost.
   */
  reportsFiled(): Promise<void>;
}

/**
 * What a run writes through and samples from. `openProgressRun` hands it the
 * host-global sink and the process's one stack sampler; a test hands it an
 * array and a fake, so it never writes the real file or claims the sampler
 * (every bun:test file shares one process, and a sampler has one owner).
 */
export interface ProgressRunDeps {
  write: (record: ProgressRecord) => void;
  sampler: StackSampler;
  /**
   * Where stall reports go. Required, so a test cannot forget it and file into
   * the host-global outbox — which main would drain into real reports.
   */
  reports: StallReportSink;
}

/**
 * Open a run: mint the `run` record and arm the `pending` heartbeat. (Retention
 * is no longer a step here — the sink rotates inside `append` itself.)
 *
 * MUST be the first thing `runChecks` does — before the checks are even loaded,
 * and certainly before the first `git` spawn. The earlier draft opened the run
 * just above the `Promise.all`, i.e. after `getRoot()` / `computeTreeHash()` /
 * `openCheckCache()` / `loadTreeSnapshot()`, and a run that wedged in any of
 * those wrote literally nothing — reproducing, inside the diagnostic itself,
 * the exact blindness the diagnostic exists to remove. Hence the argument list:
 * only what is knowable with zero work (the caller's own request), with
 * everything else deferred to `resolved()`.
 *
 * The two mechanisms here are deliberately independent. `start`/`end` (and
 * `bootstrap-start`/`bootstrap-end`) are timer-free — they are on disk before a
 * hang begins, so the culprit is the set difference `started − ended` even if
 * the event loop were fully blocked. The heartbeat needs a live loop and adds
 * the time dimension (how long each unit has been outstanding). If either
 * assumption about the hang's nature is wrong, the other still names it.
 *
 * The thread watch opens here too, beside the heartbeat, and for the same
 * reason the run record is written first: bootstrap is part of the run, and
 * `load-checks` alone keeps the thread ~2.5 s.
 */
export function openProgressRun(args: ProgressRunArgs): ProgressRun {
  return startProgressRun(args, {
    write: appendToSink,
    // The process's one JSC sampler. `runChecks` runs once per process (its
    // only caller is the `check` command), and a second claim under this same
    // owner is the same handle — so there is nothing to release.
    sampler: claimStackSampler("check-runner"),
    reports: {
      file: fileReportFromProcess,
      mergeBase: () => mergeBaseWithMain(REPO_ROOT),
    },
  });
}

interface ProgressRunArgs {
  scope: string | null;
  /** The ids the caller named, or null for "every check". */
  requested: string[] | null;
  /**
   * The run's identity, when the caller already owns one — a build's `buildId`,
   * a standalone check's `opId`. Passing it is what makes these lines joinable
   * to the run's other artifacts (`check-<runId>.log`, `build-<runId>.log`)
   * instead of only to each other. A caller with no artifact to join to omits
   * it and gets a fresh uuid.
   */
  runId?: string;
  /**
   * The run's transcript (`check-<runId>.log`), when it writes one — named in
   * the stall reports so a reader lands on the full detail.
   */
  transcriptPath?: string | null;
}

/** `openProgressRun` over any writer and sampler — see `ProgressRunDeps`. */
export function startProgressRun(
  args: ProgressRunArgs,
  deps: ProgressRunDeps,
): ProgressRun {
  const runId = args.runId ?? crypto.randomUUID();
  const pid = process.pid;
  const worktree = worktreeName();
  const startedAt = performance.now();
  const stamp = (): {
    t: string;
    runId: string;
    pid: number;
    worktree: string;
  } => ({
    t: new Date().toISOString(),
    runId,
    pid,
    worktree,
  });

  deps.write({
    ...stamp(),
    phase: "run",
    scope: args.scope,
    requested: args.requested,
  });

  const inFlight = new Set<string>();
  const inBootstrap = new Set<string>();
  // Started checks waiting on another run's flight: out of `inFlight` (not on
  // the thread), but still outstanding for the heartbeat.
  const joined = new Set<string>();

  // Stalls that miss the track's target become reports (stall-report.ts). The
  // record, the transcript and the console line are unchanged by it.
  const reporter = openStallReporter({
    worktree,
    runId,
    transcript: args.transcriptPath ?? null,
    sink: deps.reports,
  });

  // `.unref()` so this timer can never be the reason the process stays alive —
  // the heartbeat exists to observe a hang, not to cause one.
  const heartbeat = setInterval(() => {
    if (inFlight.size === 0 && inBootstrap.size === 0 && joined.size === 0)
      return;
    deps.write({
      ...stamp(),
      phase: "pending",
      elapsedMs: Math.round(performance.now() - startedAt),
      pending: [...inFlight, ...joined],
      bootstrap: [...inBootstrap],
      joined: [...joined],
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // Reads the same two sets the heartbeat does, so a stall's `running` list and
  // a `pending` record cannot disagree about what was in flight.
  const watch = openThreadWatch({
    startedAt,
    inFlight: () => ({ running: [...inFlight], bootstrap: [...inBootstrap] }),
    sampler: deps.sampler,
    onStall: (stall) => {
      deps.write({ ...stamp(), phase: "stall", ...stallRecord(stall) });
      // Filed as the stall closes, not at `finish()`: a run killed mid-pass
      // still reports the stalls it already had.
      reporter.stall(stall);
    },
  });

  return {
    runId,
    async bootstrap(step, fn) {
      inBootstrap.add(step);
      watch.noteStarted("bootstrap", step);
      deps.write({ ...stamp(), phase: "bootstrap-start", step });
      const phaseStart = performance.now();
      try {
        return await fn();
      } finally {
        // Same `finally` discipline as a check's `end`: a bootstrap phase that
        // THROWS must not be left looking like one that never returned.
        inBootstrap.delete(step);
        deps.write({
          ...stamp(),
          phase: "bootstrap-end",
          step,
          durationMs: Math.round(performance.now() - phaseStart),
        });
      }
    },
    resolved(treeHash, selected) {
      deps.write({ ...stamp(), phase: "selected", treeHash, selected });
    },
    checkStarted(checkId) {
      inFlight.add(checkId);
      // Into the watch's current window too: a check that starts and blocks in
      // the same turn is never in a tick's snapshot of `inFlight`.
      watch.noteStarted("running", checkId);
      deps.write({ ...stamp(), phase: "start", checkId });
    },
    checkJoined(checkId, leaderId) {
      inFlight.delete(checkId);
      joined.add(checkId);
      deps.write({ ...stamp(), phase: "joined", checkId, leaderId });
    },
    checkJoinEnded(checkId, adopted) {
      joined.delete(checkId);
      if (!adopted) {
        inFlight.add(checkId);
        watch.noteStarted("running", checkId);
      }
      deps.write({ ...stamp(), phase: "join-ended", checkId, adopted });
    },
    checkEnded(checkId, durationMs, ok, cached, queuedMs, sharedFrom) {
      inFlight.delete(checkId);
      joined.delete(checkId);
      const now = performance.now();
      deps.write({
        ...stamp(),
        phase: "end",
        checkId,
        durationMs,
        ok,
        cached,
        queuedMs,
        stalledMs: watch.overlapMs(now - durationMs, now),
        ...(sharedFrom !== null ? { sharedFrom } : {}),
      });
    },
    finish(allOk) {
      clearInterval(heartbeat);
      // Stopped BEFORE `done`, so its last tick (and any stall that tick
      // closes) lands inside the run, and `thread` is the run's second-to-last
      // line on every path — the early exits included.
      const thread = watch.stop();
      deps.write({ ...stamp(), phase: "thread", ...threadRecord(thread) });
      reporter.finish(thread);
      deps.write({
        ...stamp(),
        phase: "done",
        elapsedMs: Math.round(performance.now() - startedAt),
        allOk,
      });
      return thread;
    },
    reportsFiled: () => reporter.settled(),
  };
}

/** One outstanding unit of work: started, never ended. The hang suspect. */
export interface OutstandingCheck {
  checkId: string;
  startedAt: string;
  /** Milliseconds between its `start` and the run's last observed activity. */
  elapsedMs: number;
  /**
   * Set while the check is waiting on another run's in-flight check rather
   * than running: that run's id (`leaderId`, null for a leader not yet
   * recorded) and when the wait began. Always null for a bootstrap phase.
   */
  joined: { leaderId: string | null; since: string } | null;
}

/** A reconstructed run, newest activity last. */
export interface CheckRunProgress {
  runId: string;
  pid: number;
  worktree: string;
  scope: string | null;
  /** The ids the caller named, or null for "every check". Known at `run` time. */
  requested: string[] | null;
  /** Null until the run's `selected` record lands, i.e. until bootstrap ends. */
  treeHash: string | null;
  startedAt: string;
  /** Last line seen for this run — a heartbeat, an `end`, or the `run` itself. */
  lastActivityAt: string;
  /** Null while the run is still in bootstrap: the set isn't resolved yet. */
  selected: string[] | null;
  startedCount: number;
  endedCount: number;
  /**
   * Every check that SETTLED, in completion order. `at - durationMs` is the
   * start instant EXACTLY (both derive from the same `end` record, so they
   * cannot disagree), which is what lets a parent process place each check as a
   * bar in its own timeline without the child ever reporting a clock.
   *
   * This is the ONLY machine-readable per-check channel, deliberately. A
   * structured stdout line or a per-run summary JSON would duplicate a record
   * that already exists here — and both are written at the END, so they are lost
   * in exactly the case this log exists for: a killed or hung run. These `end`
   * records are on disk the instant each check settles.
   */
  completed: Array<{
    checkId: string;
    at: string;
    durationMs: number;
    ok: boolean;
    cached: boolean;
    /** The run whose verdict it adopted, or null — see the `end` record. */
    sharedFrom: string | null;
    /** Slot-wait ahead of the body; see the `end` record's own doc. */
    queuedMs: number;
    /**
     * How much of `durationMs` fell inside thread stalls. Null for a line
     * written before the watch existed: that run stalled too, unmeasured, so
     * null is "not known" where a 0 would be a claim — see the `end` record.
     */
    stalledMs: number | null;
  }>;
  /**
   * `selected − everything that has ever started`: the checks the runner's
   * concurrency gate is still holding back. DERIVED, not recorded — a queued
   * check writes no line of its own, and a second record saying "queued" could
   * disagree with the start/end records about the same check.
   *
   * Null while `selected` is null, for the same reason `selected` is: until
   * bootstrap resolves the selection there is no set to subtract from, and an
   * empty array here would read as "nothing waiting" rather than "not known
   * yet". Without this, a bounded run looks emptier than it is — `--status`
   * would report `width` running out of a hundred selected and say nothing
   * about the ninety-odd that have not been let in.
   */
  queued: string[] | null;
  /**
   * Bootstrap phases started and never ended. Non-empty means the run never
   * reached its checks at all — read this BEFORE `outstanding`, which is
   * necessarily empty in that case and would otherwise read as "healthy".
   */
  outstandingBootstrap: OutstandingCheck[];
  /** `started − ended`: empty for a healthy run, the culprit set for a hung one. */
  outstanding: OutstandingCheck[];
  /**
   * Every thread stall recorded so far, in order — readable WHILE the run is in
   * flight, since each lands the moment its late tick runs. `kinds`/`leaves`/
   * `cpu` are `null` for a stall recorded before that split existed — see
   * `ProgressStall`.
   */
  stalls: Array<
    Omit<ProgressStall, "kinds" | "leaves" | "cpu"> & {
      at: string;
      kinds: Record<StallKind, number> | null;
      leaves: Array<{ leaf: string; samples: number }> | null;
      cpu: StallCpu | null;
    }
  >;
  /**
   * The run's thread summary. Null until `finish()` writes it — and for every
   * run recorded before the watch existed. `kinds`/`cpu` are null for a run
   * recorded before that split existed, same rule as a stall's.
   */
  thread:
    | (Omit<ProgressThread, "kinds" | "cpu"> & {
        at: string;
        kinds: Record<StallKind, number> | null;
        cpu: StallCpu | null;
      })
    | null;
  /** Present iff the run reached its `done` record. */
  done: { at: string; elapsedMs: number; allOk: boolean } | null;
}

/**
 * Read the progress file and reconstruct each run. Tolerant by construction:
 * lines from concurrent worktrees interleave freely (they are grouped by
 * `runId`), a run whose `selected` record has not landed yet is a first-class
 * state rather than a parse failure, and a trailing partial line — the normal
 * state while a run is mid-write, which is exactly when this is read — is
 * skipped rather than fatal (`readJsonlTail` owns that skip now).
 *
 * `includeRotated` is NOT optional here. This is a *reconstructing* reader, not a
 * tail: a run straddling a rotation would otherwise lose its `run` line to `.1`
 * and become unattributable orphan lines. The 8 MB budget covers the sink's entire
 * 6 MB footprint (2 MB live + 2 rotations), so in practice nothing is clipped.
 *
 * Returns newest run first, ordered by last activity.
 */
export function readCheckProgress(): CheckRunProgress[] {
  const result = progressSink.readJsonlTail<ProgressRecord>({
    includeRotated: true,
    maxBytes: 8 * 1024 * 1024, // covers the full 6 MB footprint
  });
  if (result.kind === "missing") return []; // no run has ever executed on this host
  return reconstructRuns(result.records);
}

/** A record's own fields, without the envelope every line carries. */
function fieldsOf<R extends RecordBase & { phase: string }>(
  record: R,
): Omit<R, keyof RecordBase | "phase"> {
  const {
    t: _t,
    runId: _runId,
    pid: _pid,
    worktree: _worktree,
    phase: _phase,
    ...fields
  } = record;
  return fields;
}

/**
 * The reconstruction itself, over records in file order — pure, so it is
 * tested on records a test wrote to an array, never on the host-global file.
 */
export function reconstructRuns(
  records: readonly ProgressRecord[],
): CheckRunProgress[] {
  const runs = new Map<string, CheckRunProgress>();
  const startsByRun = new Map<string, Map<string, string>>();
  const bootstrapByRun = new Map<string, Map<string, string>>();
  // Every check that has EVER started, unlike `startsByRun`, from which an `end`
  // removes its entry. The queued set is `selected − this` — subtracting the
  // still-outstanding set alone would report every settled check as queued.
  const everStartedByRun = new Map<string, Set<string>>();
  // checkId → the open wait on another run's flight, per run.
  const joinedByRun = new Map<
    string,
    Map<string, { leaderId: string | null; since: string }>
  >();

  for (const record of records) {
    if (record.phase === "run") {
      runs.set(record.runId, {
        runId: record.runId,
        pid: record.pid,
        worktree: record.worktree,
        scope: record.scope,
        requested: record.requested,
        treeHash: null,
        startedAt: record.t,
        lastActivityAt: record.t,
        selected: null,
        startedCount: 0,
        endedCount: 0,
        completed: [],
        outstandingBootstrap: [],
        outstanding: [],
        queued: null,
        stalls: [],
        thread: null,
        done: null,
      });
      startsByRun.set(record.runId, new Map());
      bootstrapByRun.set(record.runId, new Map());
      everStartedByRun.set(record.runId, new Set());
      joinedByRun.set(record.runId, new Map());
      continue;
    }
    const run = runs.get(record.runId);
    // A run whose `run` line has rotated past `.2` (or fell outside the read
    // budget) leaves orphan lines; there is nothing to attribute them to, so drop
    // them rather than invent a run.
    if (!run) continue;
    run.lastActivityAt = record.t;
    const starts = startsByRun.get(record.runId);
    const boots = bootstrapByRun.get(record.runId);
    if (!starts || !boots) continue;
    if (record.phase === "bootstrap-start") {
      boots.set(record.step, record.t);
    } else if (record.phase === "bootstrap-end") {
      boots.delete(record.step);
    } else if (record.phase === "selected") {
      run.treeHash = record.treeHash;
      run.selected = record.selected;
    } else if (record.phase === "start") {
      run.startedCount += 1;
      starts.set(record.checkId, record.t);
      everStartedByRun.get(record.runId)?.add(record.checkId);
    } else if (record.phase === "joined") {
      joinedByRun.get(record.runId)?.set(record.checkId, {
        leaderId: record.leaderId,
        since: record.t,
      });
    } else if (record.phase === "join-ended") {
      joinedByRun.get(record.runId)?.delete(record.checkId);
    } else if (record.phase === "end") {
      run.endedCount += 1;
      starts.delete(record.checkId);
      joinedByRun.get(record.runId)?.delete(record.checkId);
      run.completed.push({
        checkId: record.checkId,
        at: record.t,
        durationMs: record.durationMs,
        ok: record.ok,
        cached: record.cached,
        sharedFrom: record.sharedFrom ?? null,
        // Records written before the gate landed carry no `queuedMs`. They were
        // written by an UNBOUNDED run, where every check started immediately —
        // so 0 is that run's true wait, not a stand-in for an unknown.
        queuedMs: record.queuedMs ?? 0,
        // The opposite normalization, on purpose: a line without it comes from
        // a run that stalled unmeasured, so it is unknown — null, not 0.
        stalledMs: record.stalledMs ?? null,
      });
    } else if (record.phase === "stall") {
      const { kinds, leaves, cpu, ...fields } = fieldsOf(record);
      run.stalls.push({
        ...fields,
        at: record.t,
        kinds: kinds ?? null,
        leaves: leaves ?? null,
        cpu: cpu ?? null,
      });
    } else if (record.phase === "thread") {
      const { kinds, cpu, ...fields } = fieldsOf(record);
      run.thread = {
        ...fields,
        at: record.t,
        kinds: kinds ?? null,
        cpu: cpu ?? null,
      };
    } else if (record.phase === "done") {
      run.done = {
        at: record.t,
        elapsedMs: record.elapsedMs,
        allOk: record.allOk,
      };
    }
  }

  for (const run of runs.values()) {
    const last = Date.parse(run.lastActivityAt);
    const joins = joinedByRun.get(run.runId);
    const outstandingFrom = (
      m: Map<string, string> | undefined,
      waits: typeof joins,
    ): OutstandingCheck[] =>
      [...(m ?? [])].map(([checkId, startedAt]) => ({
        checkId,
        startedAt,
        elapsedMs: last - Date.parse(startedAt),
        joined: waits?.get(checkId) ?? null,
      }));
    run.outstanding = outstandingFrom(startsByRun.get(run.runId), joins);
    run.outstandingBootstrap = outstandingFrom(
      bootstrapByRun.get(run.runId),
      undefined,
    );
    // Derived here rather than recorded: `selected` already says what the run
    // will run, and start/end already say what it has let in. Anything a queued
    // check could write would be a second spelling of that difference.
    const everStarted = everStartedByRun.get(run.runId);
    run.queued =
      run.selected === null || !everStarted
        ? null
        : run.selected.filter((id) => !everStarted.has(id));
  }

  return [...runs.values()].sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );
}
