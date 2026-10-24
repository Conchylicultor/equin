import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "fs";
import { dirname } from "path";
import { flockTry } from "@plugins/packages/plugins/flock/server";
import { adaptiveTimeoutMs } from "./adaptive-timeout";

export interface AcquireCheckoutLockOptions {
  /**
   * What the lock guards, as the noun every wait line names: `"build"`,
   * `"dependency install"`.
   *
   * REQUIRED because this one function guards two different locks in a checkout
   * (`.build.lock` and `.install.lock`). The wait line used to be a hardcoded
   * "Another build is in progress", so a `./equin test` queued behind
   * another command's `bun install` told the reader a build was running — and the
   * `Cannot find package` crash that followed pointed nowhere near the install.
   */
  what: string;
  /** How often a waiter re-inspects the lock. */
  pollMs?: number;
  /** After this long waiting, the message starts naming what the holder is stuck in. */
  staleMs?: number;
  /**
   * Wait ceiling for a holder nobody can observe (`observeHolder` omitted, or it
   * answered `unknown`): total time waited behind that one holder.
   */
  capMs?: number;
  /**
   * Ceiling for an OBSERVED holder that is working: how long it may go without
   * advancing (entering or leaving a step) before the waiter calls it wedged.
   * Has to exceed the longest single step of a healthy holder — a build's
   * checks run ~10 min with no top-level span boundary.
   */
  stallMs?: number;
  /** How often the holder is re-observed (observing reads logs; polling the flock is free). */
  observeEveryMs?: number;
  /**
   * What the holder is doing right now — supplied by the CALLER rather than read
   * here. It decides both what the waiter prints and WHEN IT GIVES UP:
   *
   * - `waiting` — the holder is itself queued in a declared wait (a host CPU
   *   grant, the duress valve). Blocked is not wedged, so the waiter's clock is
   *   paused for as long as that lasts. Without this, a holder queued behind
   *   other work made every command behind it time out: a deploy's release
   *   died after 983 s behind a main build that sat 882 s in the host-grant
   *   queue and was healthy throughout.
   * - `working` — the waiter fails after `stallMs` with no advance.
   * - `unknown` — the plain `capMs` bound, as if there were no observer.
   *
   * The authority on that is the durable build-progress + op logs, which live in
   * `op-runtime` / `op-log` because they reach the file-sink primitive and a
   * data-dir declaration. This module is statically reachable from
   * `bin/index.ts` through `ensure-deps`, i.e. it loads BEFORE `bun install` has
   * run, so it cannot import them — `cli:bootstrap-package-free` exists to keep
   * that closure empty.
   *
   * Inverting it is what removes the problem rather than hiding it. A dynamic
   * `import()` kept the closure clean but made a real cross-plugin edge
   * invisible to the boundary system, which is exactly what R9 (`inline-import`)
   * forbids. With the observer injected, the edge does not exist: `bootstrap`
   * names no plugin the pre-install path cannot afford, and the one caller that
   * HAS the logs (`app-artifacts`, deep in the build) passes it in.
   *
   * Omitted by the install lock, which no build progress covers.
   */
  observeHolder?: (pid: number) => HolderObservation;
}

/**
 * What a lock holder is doing, as its caller-supplied observer sees it. One
 * value drives both the waiter's message and its deadline, so the two cannot
 * disagree about whether the holder is stuck.
 */
export type HolderObservation =
  | { kind: "unknown" }
  | {
      kind: "waiting";
      /** The declared wait's name, e.g. `host-grant`. */
      wait: string;
      /** Epoch ms the wait opened. */
      since: number;
      /** Where a reader can see the holder's history. */
      evidence: string;
    }
  | {
      kind: "working";
      /** The innermost open step's label, when one is open. */
      step: string | null;
      /** Epoch ms of the holder's last step boundary. */
      lastAdvanceAt: number;
      evidence: string;
    };

/**
 * Cross-process per-checkout mutex, owned by the kernel. It backs both of a
 * checkout's locks — `.build.lock` (the build) and `.install.lock` (the
 * dependency install) — which is why the caller names which one in `opts.what`.
 *
 * The lock is an exclusive `flock(2)` on a regular file. flock is owned by the
 * open file description, so the kernel drops it when the fd closes OR when the
 * holding process dies — SIGKILL, OOM and power loss included — and no pid is
 * consulted, so PID reuse cannot confuse it. A build killed by a caller timeout
 * therefore cannot leave a lock that outlives it: "a stale lock with no holder"
 * is not a state this can reach.
 *
 * WHY THIS IS NOT A HEARTBEAT (do not put one back). This was a symlink whose
 * target encoded `pid-<pid>-<ts>`, refreshed on a 5 s timer, with waiters probing
 * `kill(pid, 0)` and stealing on ESRCH. That scheme had two holes the kernel
 * closes for free:
 *   - **PID reuse.** A recycled pid makes a dead holder look alive, so the waiter
 *     refuses to steal and blocks until the cap.
 *   - **Liveness is not progress.** The timer keeps stamping for as long as the
 *     event loop turns, so a build wedged on a hung child looked perfectly
 *     healthy — the freshness stamp proved only that the process existed.
 * Every other cross-process mutex in the repo (push, cpu, db-fork,
 * worktree-mutate) was already on flock; this was the last holdout.
 *
 * The lock file is NEVER unlinked — release is just `closeSync`. Unlinking is
 * what let the old `release()` (which had no ownership check) remove a
 * *successor's* lock; with the fd as the lock there is nothing to mis-delete.
 * The lock file is gitignored, so leaving it behind is free.
 *
 * The holder's pid is written into the file for DIAGNOSTICS and PATIENCE only.
 * Whether the lock is held is the kernel's answer alone; the pid only picks
 * which holder the caller's `observeHolder` describes, i.e. how long to keep
 * waiting. A misleading pid can at worst produce a misleading message or an
 * `unknown` observation — which falls back to the plain `capMs` bound.
 */
export async function acquireCheckoutLock(
  lockPath: string,
  opts: AcquireCheckoutLockOptions,
): Promise<() => void> {
  const pollMs = opts.pollMs ?? 500;
  const observeEveryMs = opts.observeEveryMs ?? 10_000;
  // Adaptive defaults computed lazily so tests overriding via `opts` don't pay
  // the `os.loadavg()` / `os.cpus()` cost.
  const staleMs = opts.staleMs ?? adaptiveTimeoutMs(60_000, 180_000);
  const capMs = opts.capMs ?? adaptiveTimeoutMs(600_000, 1_800_000);
  const stallMs = opts.stallMs ?? adaptiveTimeoutMs(1_800_000, 3_600_000);

  const startedAt = Date.now();
  let warned = false;
  let diagnosed = false;
  let holder: HolderClock | null = null;
  let observedAt = -Infinity;

  mkdirSync(dirname(lockPath), { recursive: true });
  // "a" (append), never "w": truncating would clobber the pid a live holder
  // wrote. The fd is ours alone; the flock below decides who owns the lock.
  const fd = openSync(lockPath, "a");

  for (;;) {
    if (flockTry(fd)) {
      // Safe to rewrite only now: we hold the lock, so no other holder's pid can
      // be clobbered. Truncate first so the file stays one line forever instead
      // of growing by a pid per build.
      ftruncateSync(fd, 0);
      writeSync(fd, `${process.pid}\n`);
      return makeRelease(fd);
    }

    const now = Date.now();
    if (now - observedAt >= observeEveryMs) {
      observedAt = now;
      holder = observe(holder, lockPath, now, opts.observeHolder);
    }
    // `observe` always runs on the first contended pass, so `holder` is set.
    const clock = holder!;

    if (!warned) {
      console.log(
        `Waiting for the ${opts.what} another command is running in this ` +
          `checkout${describeHolder(clock.pid)}...`,
      );
      warned = true;
      // That line names only the pid, so an observed holder still gets its
      // first description on the next pass.
      clock.announced = clock.state === "unknown" ? clock.state : null;
    } else if (clock.state !== clock.announced && opts.observeHolder) {
      // The holder moved on (a new step, into or out of a queue, a new holder):
      // one line per change, so a long wait explains itself as it goes.
      console.log(
        `Still waiting for the ${opts.what} lock; ` +
          describeObservation(clock, now),
      );
      clock.announced = clock.state;
    }

    const timeout = timeoutMessage(clock, now, { capMs, stallMs });
    if (timeout !== null) {
      closeSync(fd);
      throw new Error(
        `Timed out waiting for the ${opts.what} lock at ${lockPath}` +
          `${describeHolder(clock.pid)}: ${timeout}`,
      );
    }

    // Past the stale threshold the holder is alive (the kernel says so) but has
    // been at it a long time — so say WHAT it is doing, when the caller gave us
    // a way to find out (see `observeHolder`).
    if (!diagnosed && now - startedAt > staleMs) {
      diagnosed = true;
      console.log(
        `Still waiting (${seconds(now - startedAt)}) for the ${opts.what} lock; ` +
          describeObservation(clock, now),
      );
    }
    await Bun.sleep(pollMs);
  }
}

/**
 * The waiter's view of ONE holder. Its budget belongs to that holder: when the
 * pid in the lock file changes, a different process got the lock between our
 * polls, and it starts with a fresh clock.
 */
interface HolderClock {
  pid: number | null;
  /** When this waiter first saw this holder. */
  since: number;
  /**
   * The last instant the holder was known to be moving or legitimately
   * blocked. A working holder's stall is measured from here.
   */
  quietSince: number;
  observation: HolderObservation;
  /** A key of what the holder is doing, to print a line only on change. */
  state: string;
  announced: string | null;
}

function observe(
  prev: HolderClock | null,
  lockPath: string,
  now: number,
  observeHolder: ((pid: number) => HolderObservation) | undefined,
): HolderClock {
  const pid = readHolderPid(lockPath);
  const observation: HolderObservation =
    pid !== null && observeHolder ? observeHolder(pid) : { kind: "unknown" };
  const clock: HolderClock =
    prev !== null && prev.pid === pid
      ? prev
      : {
          pid,
          since: now,
          quietSince: now,
          observation,
          state: "",
          announced: null,
        };
  clock.observation = observation;
  if (observation.kind === "waiting") {
    // Blocked, not wedged: nothing a queued holder does counts against it.
    clock.quietSince = now;
  } else if (observation.kind === "working") {
    clock.quietSince = Math.max(clock.quietSince, observation.lastAdvanceAt);
  }
  clock.state =
    observation.kind === "waiting"
      ? `waiting:${observation.wait}`
      : observation.kind === "working"
        ? `working:${observation.step ?? ""}`
        : "unknown";
  return clock;
}

/** Why the wait is over, or `null` while the holder still earns patience. */
function timeoutMessage(
  clock: HolderClock,
  now: number,
  bounds: { capMs: number; stallMs: number },
): string | null {
  const obs = clock.observation;
  switch (obs.kind) {
    case "waiting":
      return null;
    case "working": {
      const stalled = now - clock.quietSince;
      if (stalled <= bounds.stallMs) return null;
      return (
        `the holder has not advanced for ${seconds(stalled)}` +
        `${obs.step === null ? "" : ` (still in "${obs.step}")`}, over the ` +
        `${bounds.stallMs}ms stall limit. See ${obs.evidence}`
      );
    }
    case "unknown": {
      const waited = now - clock.since;
      if (waited <= bounds.capMs) return null;
      return (
        `waited ${bounds.capMs}ms and this command cannot see what the holder ` +
        `is doing, so it gave up at the limit.`
      );
    }
  }
}

function describeObservation(clock: HolderClock, now: number): string {
  const obs = clock.observation;
  const pid = clock.pid === null ? "the holder" : `pid ${clock.pid}`;
  switch (obs.kind) {
    case "unknown":
      return clock.pid === null
        ? "holder unknown."
        : `held by pid ${clock.pid}.`;
    case "waiting":
      return (
        `${pid} is queued in "${obs.wait}" (${seconds(now - obs.since)} so far) — ` +
        `blocked, not stuck, so this wait has no limit while it lasts. ` +
        `Full history: ${obs.evidence}`
      );
    case "working":
      return (
        `${pid} is in "${obs.step ?? "a build step"}", last advanced ` +
        `${seconds(now - obs.lastAdvanceAt)} ago. Full history: ${obs.evidence}`
      );
  }
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Release = close the fd; the kernel drops the lock. Idempotent, and registered
 * as an exit hook too so a holder that never calls it still releases at exit —
 * though for the crash case the kernel has already done it.
 */
function makeRelease(fd: number): () => void {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    closeSync(fd);
  };
  process.on("exit", release);
  return release;
}

/** ` (held by pid N)`, or `` when the file has no readable pid. Diagnostics only. */
function describeHolder(pid: number | null): string {
  return pid === null ? "" : ` (held by pid ${pid})`;
}

function readHolderPid(lockPath: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const pid = parseInt(raw.trim(), 10);
  return Number.isInteger(pid) ? pid : null;
}
