import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { SpawnTier } from "@plugins/packages/plugins/spawn-priority/core";
import type { PeakFootprint } from "@plugins/packages/plugins/proc-rusage/core";

// The shared shapes of the wedge-proof spawn primitive.
//
// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: the impls next door
// own `node:fs`. This plugin must never be imported from `web/`.

/**
 * The BOUND half of `SpawnOptions` — the two ways a caller can promise that
 * this child cannot run forever. Named separately so a wrapper can take "just
 * the bound" as one parameter, and so the step that made a bound MANDATORY was
 * a change to this one type rather than to every option list.
 *
 * Both members are optional HERE, because `SpawnOptions` below is the union
 * that makes at least one of them (or the explicit `unbounded` opt-out)
 * unavoidable. This interface stays the plain "just the bound" bag so a wrapper
 * that forwards a bound it was handed can keep taking it as one parameter.
 */
export interface SpawnBound {
  /**
   * Hard ceiling for the child, in ms of time the machine was AWAKE (sleep is
   * not counted: a laptop dozing past the deadline gave the child none of it —
   * `awake-deadline.ts`). On expiry the child is sent
   * `SIGTERM`, then `SIGKILL` after a short grace, and the result comes back
   * with `timedOut: true` — a RESULT, not a throw, so the caller classifies it.
   *
   * One-shot deadline, not a polling loop. This is the arm to reach for
   * whenever the CALLER owns a deadline it must honor (an HTTP request that
   * cannot hang on a wedged network peer; a reaper holding a host-wide flock),
   * and the value should be sized to THAT work — see `SpawnOptions` for why
   * picking one number for everything is the wrong shape.
   */
  timeoutMs?: number;
  /**
   * Ambient cancellation: when it aborts, the child gets the same
   * `SIGTERM` → grace → `SIGKILL` escalation as a deadline, and the call
   * **THROWS `signal.reason`** once the child is reaped.
   *
   * The asymmetry with `timeoutMs` (result field) is deliberate. `timeoutMs` is
   * the caller's OWN deadline, so the caller is the right place to classify it.
   * An abort is ambient — "everything you are doing has been abandoned" — and a
   * result field would be absorbed: a caller whose `catch`/branch maps a failed
   * probe to a conservative default would swallow it and then go on to do a
   * hundred more spawns after being told to stop. That is the absorbed-failure
   * pattern the repo bans, so the abort is a throw the caller cannot mistake for
   * a value. It also means `spawnExpectOk` needs no special case: the abort
   * propagates before the exit-code check, so it is never mis-reported as
   * `SpawnFailedError`.
   *
   * `signal.reason` is rethrown as-is (the standard `AbortSignal` contract), not
   * wrapped in a fresh error, so whoever aborted can attach context that surfaces
   * at the wedge site.
   *
   * Two edges worth knowing:
   * - **Abort beats `timedOut`.** If both fire, in either order, the call
   *   throws; it never returns a `timedOut: true` result.
   * - **An abort after a clean exit still throws**, discarding a good result.
   *   Correct — the caller was told to stop before it was handed the value — but
   *   surprising if you expect "the work finished, so it counts".
   */
  signal?: AbortSignal;
}

/**
 * The UNBOUNDED half of `SpawnOptions`: the everything-else options, which say
 * nothing about how long the child may run. Split out so the bound can be
 * intersected onto it as a union (see `SpawnOptions`).
 */
export interface SpawnBaseOptions {
  /** Working directory of the child. Defaults to the parent's cwd. */
  cwd?: string;
  /** FULL environment replacement — the same contract as `Bun.spawn`'s `env`. */
  env?: Record<string, string | undefined>;
  /**
   * Whole-buffer stdin, delivered via a temp-file fd (the child reads it and
   * then sees EOF). There is deliberately no streaming form — a JS-side stream
   * pull is the exact machinery this plugin exists to remove.
   */
  stdin?: string | Uint8Array;
  /**
   * The scheduling tier the child (and its whole subtree) starts in. Omitted =
   * `inherit`. `background` demotes it (`taskpolicy -b`); `foreground` starts it
   * out of darwinbg even from a darwinbg parent — for a scarce host-pool slot's
   * holder, which reaches it through its pool's `Slot` rather than spelling it.
   */
  tier?: SpawnTier;
  /** Redirect stderr into the stdout fd (2>&1). `result.stderr` is then `""`. */
  mergeStderr?: boolean;
  /**
   * Let a git child write its index opportunistically (no
   * `GIT_OPTIONAL_LOCKS=0`). Only for a git child whose `GIT_INDEX_FILE` names
   * a PRIVATE index the caller owns (a scratch copy): there is no other
   * process to collide with on its lock, and the write is what the caller is
   * after — `git status` saving its refreshed stats and untracked cache into
   * it. Never for a checkout's own index; see `child-env.ts`.
   */
  privateIndexWrites?: true;
  /**
   * `"report"`: measure the child's peak physical footprint — what the run
   * needed, as the kernel charges it — into `resourceUsage.peakFootprint`. The
   * child reports it itself as it exits, through a `BUN_OPTIONS` preload, so
   * the child MUST be a bun script run (`bun <file>`): `bun install`, `bun x`
   * and `bun build` read the preload as their script name and fail. Omitted,
   * the peak is `unmeasured: not-requested`.
   */
  peakFootprint?: "report";
}

/**
 * Options for the capture-shaped spawns (`spawnCaptured` / `spawnExpectOk`).
 *
 * **A BOUND IS MANDATORY, and the union is how.** Omitting one has no spelling:
 * every call must say either how long this child may run (`timeoutMs`), whose
 * cancellation it obeys (`signal`), or — in prose — why nothing bounds it
 * (`unbounded`). There is nothing to remember and nothing to enforce elsewhere;
 * `tsc` rejects the unbounded wait at the call site (rung 2 of the fix ladder).
 *
 * The gate for requiring this flipped. `spawn/CLAUDE.md` used to set the
 * criterion as "the absence of an observed field wedge, diagnosed by hand", and
 * a field wedge has now been observed TWICE — including the 2026-08-17 outage,
 * where an unbounded `git worktree remove` held the host-wide `worktree-mutate`
 * flock and stopped worktree checkouts on every backend on the box. Nothing else
 * catches this: the fleet-level op-wedge watchdog was retired 2026-07-28 as an
 * all-false-positive instrument, so an unbounded hung child hangs until a human
 * notices.
 *
 * Pick the arm from what actually bounds the work — never a blanket number:
 *
 * - **`timeoutMs`** when the caller owns a deadline (an HTTP request, a job
 *   handler, a reaper holding a host-wide slot). Size it to the command; the
 *   named per-operation constants in `infra/worktree`'s `worktree.ts` are the
 *   house style, and their calibration comment is worth reading before guessing
 *   a number — these are WEDGE-BREAKERS, so far above p99, not latency police.
 * - **`signal`** when the caller already holds one (a job handler's
 *   `ctx.signal`), alone or together with `timeoutMs` — a class deadline and a
 *   per-command ceiling are different facts and both can be true.
 * - **`unbounded`** only where nothing shorter than the work bounds it. The
 *   value is a SENTENCE saying why, not a flag: prose cannot be copy-pasted
 *   without reading it, and `rg "unbounded:"` enumerates every one of them in a
 *   form a reviewer can actually audit. It has NO runtime effect whatsoever —
 *   it exists to be typed and to be grepped.
 */
export type SpawnOptions = SpawnBaseOptions &
  (
    | { timeoutMs: number; signal?: AbortSignal; unbounded?: never }
    | { signal: AbortSignal; timeoutMs?: number; unbounded?: never }
    | {
        /**
         * Why this child has no ceiling, in prose. Purely declarative — nothing
         * reads it at runtime — so its whole value is that a reviewer and
         * `rg "unbounded:"` can both find it.
         *
         * The honest case is the CLI: a `./equin build` step runs for ten
         * minutes because the build takes ten minutes, and there is no shorter
         * deadline to borrow from. A server-side call site almost never belongs
         * here — its request or its job has a deadline, and that is the bound.
         */
        unbounded: string;
        timeoutMs?: never;
        signal?: never;
      }
  );

/**
 * What a child cost, once it has been reaped.
 *
 * Every field is the TRUE total of the run — no sampling loop, no estimate. The
 * CPU times are getrusage's, `undefined` when the runtime reported no rusage at
 * all: an unavailable measurement, not a failure. The peak memory is the
 * child's own report of its physical footprint, or why there is none — there is
 * no peak RSS here, because getrusage's counts pages the child already freed
 * (a type-check worker: 1.8 GB maxRSS for a 1.15 GB footprint).
 *
 * CPU time is here beside peak RSS because wall clock on a shared host is not a
 * cost: the same type-check worker measured 2.5x apart at load 5.8 and load 14.
 * CPU seconds are load-independent, so they are the only honest unit for "what
 * did this child cost", which is what every before/after measurement of the
 * check fleet needs. See research/2026-09-08-global-type-check-per-target-program-skip.md.
 */
export interface ChildResourceUsage {
  /**
   * The child's peak physical footprint (`SpawnBaseOptions.peakFootprint`).
   * The only peak-memory spelling a spawn has.
   */
  peakFootprint: PeakFootprint;
  /** User + system CPU consumed by the child, in MICROseconds. */
  cpuTimeMicros: number | undefined;
  /**
   * The SYSTEM share of `cpuTimeMicros` (kernel time on the child's behalf), in
   * MICROseconds. Separated because it is what memory pressure inflates: page
   * faults and compressor decompressions are charged here, so a run whose total
   * balloons while its system share does too was paying for the host, not doing
   * more of its own work. See research/2026-10-15-global-push-typecheck-lane-priority-and-cap.md.
   */
  cpuSystemMicros: number | undefined;
}

/** What a completed capture-shaped spawn returns. */
export interface SpawnResult {
  /** ≠ 0 is a legitimate result — the caller branches. `spawnExpectOk` throws instead. */
  exitCode: number;
  signalCode: string | null;
  /**
   * True when `opts.timeoutMs` expired and WE killed the child. An explicit
   * flag rather than something to infer from `signalCode`: a child can be
   * SIGTERM'd by anyone (a user ^C, an operator killing a tree by hand), so the
   * signal alone never says whose deadline fired.
   */
  timedOut: boolean;
  /** Lazy, cached utf8 decode of `stdoutBytes`. */
  stdout: string;
  /** Lazy, cached utf8 decode of `stderrBytes`. Always `""` under `mergeStderr`. */
  stderr: string;
  /**
   * Raw output bytes, for byte-offset parsers (`git cat-file --batch` framing).
   * Each is a fresh copy over its own `ArrayBuffer` (never a shared/pooled one),
   * which is what lets it go straight into a `Response` body.
   */
  stdoutBytes: Uint8Array<ArrayBuffer>;
  stderrBytes: Uint8Array<ArrayBuffer>;
  resourceUsage: ChildResourceUsage;
}

/** The live child handle `spawnPassthrough` exposes for signal forwarding. */
export interface SpawnedChild {
  pid: number;
  kill: (signal?: number | NodeJS.Signals) => void;
}

/** Options for `spawnPassthrough` (stdout/stderr inherit, stdin ignore by default). */
export interface SpawnPassthroughOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** The child's scheduling tier, as for `SpawnBaseOptions.tier`. */
  tier?: SpawnTier;
  /**
   * The child's stdin. Defaults to `"ignore"`: the exec-shaped build/push steps
   * read no input, and an inherited stdin would let a child silently consume the
   * parent's.
   *
   * `"inherit"` is for a child that must be INDISTINGUISHABLE from the parent —
   * today only the CLI bootstrap's post-install re-exec (`bin/reexec.ts`), which
   * hands the user's own command to a fresh process. There, `"ignore"` would be a
   * behavior change hiding in a fd: invisible until the day a command reads
   * stdin, and then only on the rare install path.
   */
  stdin?: "ignore" | "inherit";
  /**
   * `"report"`: measure the child's peak physical footprint — what the run
   * needed, as the kernel charges it — into `resourceUsage.peakFootprint`. The
   * child reports it itself as it exits, through a `BUN_OPTIONS` preload, so
   * the child MUST be a bun script run (`bun <file>`): `bun install`, `bun x`
   * and `bun build` read the preload as their script name and fail. Omitted,
   * the peak is `unmeasured: not-requested`.
   */
  peakFootprint?: "report";
  /** Called synchronously after spawn with `{ pid, kill }` (signal forwarding). */
  onSpawn?: (child: SpawnedChild) => void;
  /**
   * `"own"`: the child leads a process group of its own (pgid = its pid), and
   * that group dies with it — everything the child started, at any depth, that
   * did not leave the group. Once the child has exited, whatever is still in
   * its group is named (the result's `leftBehind`) and SIGKILLed; when THIS
   * process exits first, the exit reaper SIGKILLs the whole group instead of
   * SIGTERMing the child alone.
   *
   * For a child whose descendants are not ours to keep: a test runner, whose
   * suites spawn helpers that a failed or killed test never ends (2026-11-08:
   * three socket-client.test helpers orphaned to pid 1 for 45 h). Not for a
   * child that is itself an op CLI: its own exit hooks would get no SIGTERM.
   *
   * The one way out of the group is a descendant that starts a session of its
   * own (`setsid`, `detached: true`) — the supervised / daemon spawns that are
   * meant to outlive any call, each sanctioned by an exemption.
   */
  processGroup?: "own";
}

/** A process still in a `processGroup: "own"` child's group after the child exited. */
export interface LeftBehindProcess {
  pid: number;
  /** Its command line, as `ps` printed it. */
  command: string;
}

/**
 * Options for `spawnToFile`: `spawnPassthrough`'s, plus the file its output goes
 * to — minus `processGroup`, whose `leftBehind` its result has no place for.
 */
export interface SpawnToFileOptions extends Omit<
  SpawnPassthroughOptions,
  "processGroup"
> {
  /** Appended to (created when missing) with the child's stdout and stderr, merged. */
  outputPath: AppPath;
}

export interface SpawnPassthroughResult {
  exitCode: number;
  signalCode: string | null;
  resourceUsage: ChildResourceUsage;
}

/** A `processGroup: "own"` run's result: what it left behind in its group, now killed. */
export interface SpawnGroupResult extends SpawnPassthroughResult {
  /**
   * The processes still in the child's group when it exited — SIGKILLed before
   * this resolved. Empty when the child's descendants all ended with it.
   */
  leftBehind: LeftBehindProcess[];
}
