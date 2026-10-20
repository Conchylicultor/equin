import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  flockTry,
  flockTryShared,
  waitForFlock,
  type HeldFlock,
} from "@plugins/packages/plugins/flock/server";
import type { DataDir } from "@plugins/infra/plugins/paths/core";

// Cross-process twin of `createSemaphore` (the in-process counter+queue gate in
// `packages/semaphore`). Bounds CPU-heavy work *across* the ~16 worktree server
// processes sharing one box, not just within one. The bound is N flock(2) lock
// files in a caller-supplied declared directory: at most one holder per fd, so at
// most `size` holders host-wide. flock auto-releases when the fd closes OR the
// holding process dies, so a SIGKILLed server never leaks a slot — the same
// crash-safety every host pool relies on (declared via `infra/host/host-admission`).
//
// Hybrid acquire:
//  - Fast path: an in-process *non-blocking* `flock(LOCK_NB)` sweep — microsecond
//    syscalls that never freeze the event loop. When a slot is free this is the
//    whole story; no subprocess, no tax.
//  - Slow path (all slots busy): we must *wait* for a slot, but a blocking
//    `flock(LOCK_EX)` would freeze the long-running event loop. We can't wait on a
//    single slot fd either — a blocking flock parks on ONE open file description,
//    so if a *different* slot frees the waiter is never woken and that slot sits
//    idle (the stranding defect). Instead the head waiter *fans out*: it spawns one
//    `flock-wait` child per slot and takes the FIRST to grant, so ANY freed slot
//    wakes it — including one freed by a SIGKILLed holder, which flock releases too.
//    A per-pool **turnstile** (itself a single flock file) ensures only the *head*
//    waiter fans out host-wide, so the extra process cost is a fixed `size - 1` per
//    contended pool, not `size × waiters`.
//
// Deadlock-free: the turnstile is only ever held by *waiters*; a slot-holder never
// needs it, and a turnstile-holder waits only for a slot, which holders always
// release. The wait-for graph is acyclic.
//
// Barging is unchanged: the fast-path sweep does not consult the turnstile, so a
// fresh caller can still take a slot a queued waiter was about to win. The turnstile
// buys serialized *wakeup*, not FIFO *fairness*.
//
// Cancellable: every wait above accepts an optional `AbortSignal` (see
// `AcquireHooks.signal`). Both waits are waits on a CHILD's stdout, so cancellation
// is uniformly "kill our own children and let the read finish as EOF" rather than a
// race against the signal — nothing is ever abandoned mid-read. That matters beyond
// tidiness: a caller blocked in here is holding a HOST-WIDE resource, so whether an
// abandoned caller can be made to let go decides whether one wedged handler costs
// one process or every process on the box.
//
// Reserved floor: with `backgroundLimit < size`, slot *capacity* is partitioned by
// lane. `background` may only sweep/fan-out over `slot-0 … slot-(backgroundLimit-1)`;
// `interactive` may use every slot but sweeps them HIGH-index-first, so the reserved
// high slots fill before the shared low slots and a saturated background lane can
// never starve interactive work. The turnstile stays PER-POOL (shared across lanes) —
// only slot capacity is partitioned, not the wakeup serialization — so an interactive
// waiter may briefly queue behind a background waiter's fan-out for the wakeup (a few
// ms), never for a slot.

// Every wait below — the turnstile, the size guard, each fan-out slot — is ONE
// `waitForFlock` (`packages/flock`): a `flock-wait` child that blocks off our event
// loop on one lock file and then HOLDS it until released, or until we die. The
// child script used to live here; it moved to `packages/flock` so other waiters
// (single-flight) share it.

export interface HostShare {
  /** Slots actually held — always >= 1, never > the requested max. */
  readonly slots: number;
  /** Idempotent. Closes local fds and reaps the winner child (if one was spawned). */
  release(): Promise<void>;
  /**
   * The SYNCHRONOUS half of `release()`: the instant this returns, every slot is
   * back host-wide. Closing an fd drops its flock, and killing the winner child
   * drops the flock it holds, because flock releases on process death — so the
   * only thing `release()` still does afterwards is REAP the killed child, which
   * is hygiene, not the bound.
   *
   * It exists for one caller shape: an `AbortSignal` listener, which cannot
   * await. Handing the slots back from inside the abort event is what makes
   * cancellation containment rather than bookkeeping — the flock is gone before
   * the abandoned handler has even begun to unwind. Everything else should call
   * `release()`, which is idempotent and does this first.
   */
  releaseSlots(): void;
}

/**
 * Reserved-floor lane. A pool with `backgroundLimit < size` partitions its slots by
 * lane so background work can never starve interactive work of the whole pool:
 *  - `background` may use only the low `backgroundLimit` slots (`slot-0 …
 *    slot-(backgroundLimit-1)`), swept low-index-first.
 *  - `interactive` may use ALL `size` slots, but sweeps them **high-index-first**
 *    (`slot-(size-1) … slot-0`). Without that reversal, interactive holders would take
 *    the low slots in file order and the reserved floor (the high slots background can
 *    never reach) would sit empty while background starves — the whole trick.
 *
 * Default `background`: the safe choice, since it can never encroach on the reserved
 * floor. When `backgroundLimit === size` (the un-partitioned default), both lanes
 * collapse to the full slot set — `interactive` in reverse order, `background` in
 * forward order — and lane windowing is behaviourally inert.
 */
export type Lane = "interactive" | "background";

/**
 * Admission priority, orthogonal to the lane. A lane decides WHICH slots an
 * acquire may take; a priority decides WHO GOES FIRST when several want one.
 *
 *  - `normal` (default) — today's behaviour. While a `normal` acquire is WAITING
 *    (slow path: every slot in its window busy), it announces demand by holding a
 *    SHARED flock on the pool's `demand.lock`.
 *  - `low` — yields to that demand. Before taking a slot it checks the demand
 *    lock (a non-blocking EXCLUSIVE try); while any `normal` waiter holds it
 *    shared, it waits (one `flock-wait` child on the exclusive lock — granted by
 *    the kernel the instant the last `normal` waiter stops waiting, no polling).
 *    And when it WINS a slot while a `normal` waiter has appeared meanwhile, it
 *    hands the slot straight back and waits again, so the `normal` waiter gets it.
 *
 * So a `low` acquire runs only when no `normal` acquire of the same pool is
 * waiting: it fills idle capacity and never takes a slot a `normal` caller is
 * queued for. It does NOT pre-empt — a `low` holder keeps its slot until it
 * releases. And it may starve while `normal` demand never lets up, which is the
 * point: the sidequest track runs after the main track.
 *
 * Crash-safe like every lock here: a `normal` waiter that dies drops its shared
 * lock with the process. The demand lock is per POOL (every lane), because a
 * `normal` interactive waiter wants the very slot a `low` background acquire
 * would take.
 */
export type Priority = "normal" | "low";

/**
 * Per-acquire options: the reserved-floor `lane`, an optional `signal`, plus two
 * observability hooks. The hooks are optional and neither gates behavior; they let
 * callers make the gate visible (profiler spans, log lines) without coupling this
 * primitive to any of that. `lane` and `signal` DO gate behavior — `lane` selects
 * the slot window and sweep order (see `Lane`), and `signal` cancels (see below).
 */
export interface AcquireHooks {
  /**
   * Which reserved-floor lane this acquire draws from. Default `background`. On an
   * un-partitioned pool (`backgroundLimit === size`) it only affects sweep *order*,
   * not which slots are reachable.
   */
  lane?: Lane;
  /**
   * Admission priority (default `normal`) — whether this acquire yields to
   * waiting `normal` acquires of the same pool. See `Priority`.
   */
  priority?: Priority;
  /**
   * Ambient cancellation for this acquire. Optional everywhere: omitting it is
   * exactly today's behavior, so nothing that does not pass one changes.
   *
   * WHY THIS EXISTS. A worker that gives up on a wedged handler has exactly one
   * lever — it aborts a signal; it cannot un-await a promise. So whether giving
   * up releases anything depends entirely on whether what the handler is blocked
   * on accepts a signal. `spawnCaptured` does, `fetch` does, and this acquire did
   * not. On 2026-08-17 a handler sat inside a `worktree-mutate` acquire — a
   * HOST-WIDE flock — and blocked worktree checkouts on every backend on the
   * machine. Without cancellation here, "forfeiting" that handler's slot is
   * bookkeeping; with it, the host resource actually comes back.
   *
   * Two effects, and they are different questions:
   *
   * 1. **A pending acquire stops waiting.** If the signal fires while we are
   *    queued — for the turnstile, or fanned out over the lane's slots — the wait
   *    unwinds and the call THROWS `signal.reason`. Every child we spawned is
   *    killed and reaped and every fd we opened is closed on the way out; leaking
   *    a `flock-wait` child or an fd here would be worse than the wedge, since
   *    both hold slots the pool can no longer see. An acquire that has already
   *    won its slots when the abort lands hands them straight back and throws
   *    too, rather than returning a share to an owner that has stopped running.
   *
   * 2. **`run` stops HOLDING the slot mid-body** — see `HostSemaphore.run`.
   *
   * The failure is always a THROW of `signal.reason` (the standard `AbortSignal`
   * contract, and the same shape `SpawnBound.signal` uses), never a result field
   * and never a `slots: 0` share: a cancelled acquire that came back as a value
   * is precisely the absorbable failure a caller would go on to treat as
   * admission. `throwIfAborted()` runs before anything else, so a caller that was
   * already told to stop never opens a new wait.
   *
   * One consequence for the hooks below: a CANCELLED acquire never fires
   * `onAcquired`, even if `onWaitStart` already fired. A consumer that pairs the
   * two must tolerate a wait that ends in a throw.
   */
  signal?: AbortSignal;
  /**
   * The slow path was entered (every slot in the lane's window busy), BEFORE any child
   * is spawned. Never fires on the fast path. Lets a caller *open* a "waiting for a
   * slot" span, which `onAcquired` (fired once, at acquisition) can never express.
   */
  onWaitStart?(): void;
  /**
   * Always fires, fast path or slow, exactly once, at acquisition, before the body
   * runs. Its argument is the milliseconds spent waiting (≈0 on the fast path).
   * Replaces the old positional `onWait` and keeps identical semantics.
   */
  onAcquired?(waitMs: number): void;
}

export interface HostSemaphore {
  /**
   * The slot-file set this instance is currently sweeping — the pool's LIVE
   * identity, which is not always the `size` this process was built for: when
   * another process already has the pool open at a different size, this instance
   * adopts that one (see `createHostSemaphore`). Observability only; the acquire
   * path reads the same value internally.
   *
   * Reflects the last reconcile, so it is the declared size until the first
   * acquire has run.
   */
  liveSize(): number;

  /**
   * Run `fn` once a host-wide slot is free, releasing the slot when it settles.
   * The slot is released in a `finally`, so a rejecting `fn` never leaks one —
   * `run` rejects with the same error. Mirrors `Semaphore.run` exactly, except
   * the bound is enforced across processes (flock) rather than in-process.
   *
   * A thin wrapper over `acquireShare(1, hooks)`: acquire exactly one slot, hold it
   * across `fn`, release in a `finally`. That dedup keeps the fast/slow acquire,
   * `depth()` semantics, and crash-safety identical between the two entry points.
   *
   * With `hooks.signal`, an abort that lands while `fn` is STILL PENDING releases
   * the slot immediately instead of waiting for `fn` to settle. Two halves of that
   * are worth being precise about, because they are easy to read as one thing:
   *
   * - `run` does **not** cancel `fn`. It has no way to — you cannot un-await a
   *   promise. `fn` owns its own cancellation and holds the same signal; all `run`
   *   does is stop holding the HOST resource on its behalf, which is the half that
   *   protects every other process on the box. A body that ignores its signal
   *   keeps running, it just no longer occupies a slot while doing so — and if it
   *   finishes anyway, `run` returns its value. It did the work; only `fn` is in
   *   a position to decide that a post-abort result should be discarded, and it
   *   holds the signal it needs to decide that.
   * - Releasing early is safe because `HostShare.release()` is idempotent: the
   *   `finally` still calls it when `fn` finally settles, and that call is then a
   *   no-op for the slots and reaps the winner child.
   */
  run<T>(fn: () => Promise<T>, hooks?: AcquireHooks): Promise<T>;

  /**
   * Block until at least ONE slot is held, then greedily take any additional
   * free slots up to `max` with a single non-blocking sweep. Returns a
   * `HostShare` naming how many slots were actually taken (`1 … min(max, size)`)
   * and a `release()` that hands them all back.
   *
   * The point is one *share* per caller, not one child per slot in steady state: a
   * caller that fans out N units of work acquires its whole share once, up front,
   * instead of spawning N waiters (one per unit) precisely when the box is already
   * busy. The idle-pool case is the fast path — pure in-process `flock(LOCK_NB)`
   * sweep, no subprocess. Only when every slot is busy do we take the turnstile and
   * fan out one blocking child per slot to wait for the FIRST free slot; a second
   * non-blocking sweep then picks up whatever else freed while we waited.
   *
   * `max` is clamped to the acquiring lane's window size (`backgroundLimit` for the
   * `background` lane, `size` for `interactive`) — asking for more slots than the
   * window holds is a no-op past the ceiling, not an error. Never returns fewer than
   * 1 slot — it blocks or throws instead, so a caller never has to distinguish "got a
   * share" from "got nothing". The `lane` field of `hooks` selects the reserved-floor
   * window and sweep order (default `background`; see `Lane`).
   *
   * `hooks.signal` cancels the ACQUIRE only. Once a share is in your hands, its
   * lifetime is yours: a signal cannot know when you are done with it, so nothing
   * here releases it behind your back. That is the whole difference from `run`,
   * which owns the share's lifetime and therefore can (and does) hand it back the
   * moment its body is abandoned.
   */
  acquireShare(max: number, hooks?: AcquireHooks): Promise<HostShare>;

  /**
   * The number of callers currently parked on the SLOW path (all slots busy,
   * fanning out for a slot). Fast-path callers that grabbed a slot immediately are
   * NOT counted — this is the queue-depth gauge, not the in-flight count. 0 means
   * the gate is uncontended. Observability-only; never gates behavior.
   */
  depth(): number;
}

/**
 * A slot directory inside ONE git repository — for a gate whose scope is that
 * repository rather than the machine: `<gitCommonDir>/singularity-locks/<name>/`.
 *
 * The exception to "the caller supplies a declared `DataDir`", and not a way
 * back to minting data-root paths: the directory lives in the repository's own
 * git dir, which git owns and which disappears with the repository. Every
 * worktree of one repository shares the common dir, so they share the gate;
 * two repositories never do.
 */
export interface RepoLockDir {
  readonly kind: "repo-lock";
  /** Absolute `git rev-parse --git-common-dir`. */
  readonly gitCommonDir: string;
  /** One lowercase-kebab segment, e.g. `push`. */
  readonly name: string;
}

/** The three things the gate reads off its slot directory, whichever kind. */
function slotAccess(slots: DataDir | RepoLockDir): {
  spec: { name: string };
  file(rel: string): string;
  ensure(): void;
} {
  if ("kind" in slots && slots.kind === "repo-lock") {
    if (!/^[a-z][a-z0-9-]*$/.test(slots.name)) {
      throw new Error(
        `createHostSemaphore: repo-lock name must be one lowercase-kebab segment, got ${JSON.stringify(slots.name)}`,
      );
    }
    const dir = join(slots.gitCommonDir, "singularity-locks", slots.name);
    return {
      spec: { name: `${slots.name} (${slots.gitCommonDir})` },
      file: (rel) => join(dir, rel),
      ensure: () => {
        mkdirSync(dir, { recursive: true });
      },
    };
  }
  const dataDir = slots as DataDir;
  return {
    spec: dataDir.spec,
    file: (rel) => dataDir.file(rel),
    ensure: () => {
      dataDir.ensure();
    },
  };
}

/**
 * Cross-process bounded-concurrency gate: at most `size` `run` bodies execute at
 * once across every process sharing the same slot directory.
 *
 * `slots` is that directory, and the caller supplies it as a **declared**
 * `DataDir` — this primitive derives no path of its own. It used to, with
 * ``join(SINGULARITY_DIR, `${name}-slots`)``, and that one line is why the data
 * root grew a top-level directory per pool that nothing in the repo could
 * enumerate. The pool's identity (the `name` in every error below) is the
 * directory's own declared name, so the two can no longer disagree.
 *
 * The path is read through `slots.path` on every use, never captured at
 * construction: `defineHostPool` runs at consumer module eval, and a frozen
 * value there would not follow a `SINGULARITY_DIR` the release launcher sets
 * later.
 *
 * `backgroundLimit` (default `size`, i.e. no reserved floor) caps how many slots the
 * `background` lane may take, reserving the remaining `size - backgroundLimit` slots
 * for the `interactive` lane (see `Lane`). It must be an integer in `1 … size`. When
 * left at the default, lane windowing is inert and behavior is identical to an
 * un-laned pool.
 */
export function createHostSemaphore(opts: {
  slots: DataDir | RepoLockDir;
  size: number;
  backgroundLimit?: number;
}): HostSemaphore {
  const slots = slotAccess(opts.slots);
  // The pool's identity, for the error messages below. Not a separate input:
  // `defineDataDir` already validated it as one lowercase-kebab path segment, so
  // the name-vs-directory drift the old `name` parameter allowed is gone.
  const name = slots.spec.name;
  const declaredSize = opts.size;
  const declaredBackgroundLimit = opts.backgroundLimit ?? declaredSize;
  if (!Number.isInteger(declaredSize) || declaredSize < 1) {
    throw new Error(
      `createHostSemaphore: size must be a positive integer, got ${declaredSize}`,
    );
  }
  if (
    !Number.isInteger(declaredBackgroundLimit) ||
    declaredBackgroundLimit < 1 ||
    declaredBackgroundLimit > declaredSize
  ) {
    throw new Error(
      `createHostSemaphore: backgroundLimit must be an integer in 1..${declaredSize}, got ${declaredBackgroundLimit}`,
    );
  }
  // The identity this instance is ACTUALLY sweeping. It starts at the declared pair
  // and is reconciled against the on-disk sentinel on every acquire: when another
  // process already has the pool open at a different pair, this instance adopts that
  // one rather than imposing its own (see `doEnsureSizeIdentity`). Mutable for exactly
  // that reason — everything below reads these through the closure at call time, so an
  // adoption re-aims the sweep, the lane windows and the `max` clamp together.
  let size = declaredSize;
  let backgroundLimit = declaredBackgroundLimit;

  // The ordered slot-index window a lane may sweep. `background` is confined to the
  // low `backgroundLimit` slots in forward order; `interactive` may use every slot but
  // sweeps them high-index-first so the reserved floor (the high slots) fills before
  // the shared low slots, leaving the low slots for background. This is the whole
  // reserved-floor trick and it costs one reversal. When `backgroundLimit === size`
  // the two windows cover the same set — `interactive` reversed, `background` forward.
  const laneOrder = (lane: Lane): number[] =>
    lane === "background"
      ? Array.from({ length: backgroundLimit }, (_, i) => i)
      : Array.from({ length: size }, (_, i) => size - 1 - i);

  // Resolved per call, never captured — see the docblock on `slots`.
  const slotFile = (i: number) => slots.file(`slot-${i}.lock`);
  const turnstileFile = () => slots.file("turnstile.lock");
  const demandFile = () => slots.file("demand.lock");
  const sizeFile = () => slots.file("size");
  const guardFile = () => slots.file(".size.lock");

  // Queue-depth gauge: how many callers are currently parked on the slow path.
  // Incremented when entering the slow path and decremented in a `finally`
  // bracketing the whole wait — never inline, since a thrown acquire would
  // otherwise permanently inflate the gauge.
  let waiting = 0;

  // Size AND the lane split are part of the pool's identity. `size` names the
  // slot-file *set*, so an old-size process holding `slot-7.lock` is invisible to a
  // new-size process that only sweeps `slot-0..3` — the bound would be silently
  // exceeded. `backgroundLimit` names where the reserved floor begins, so two
  // processes that disagree on it partition the same slots differently — one's
  // background slot is another's reserved-interactive slot, and the floor guarantee
  // silently breaks. The `<dir>/size` sentinel encodes BOTH as
  // `"<size>:<backgroundLimit>"` and is the ONE authority every process defers to.
  //
  // Reconciled on EVERY acquire, not once per instance: the pool's identity is host
  // state, and a long-lived process that checked once could keep sweeping a slot set
  // the rest of the host has since stopped looking at — the very overcommit the
  // sentinel exists to prevent. The check is a single read of a ~4-byte file on the
  // agreeing path (the overwhelming case) and only takes the guard + does real work
  // when the on-disk pair has actually moved. In-flight runs are shared (the promise
  // memo) so concurrent in-process acquires reconcile once rather than racing, and the
  // memo clears on settle so nothing caches a since-resolved state.
  let reconcile: Promise<void> | undefined;

  function readSentinel():
    { size: number; backgroundLimit: number } | undefined {
    let raw: string;
    try {
      raw = readFileSync(sizeFile(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    // Identity is "<size>:<backgroundLimit>". A bare "<size>" is the LEGACY format
    // (pre-reserved-floor) and means "no floor" — i.e. backgroundLimit === size — so
    // it parses cleanly rather than throwing: the four historical non-laned pools keep
    // their slot dirs, and their on-disk "4"/"3"/"2" sentinels must migrate silently,
    // not crash the first acquire on a hot server path. Anything else — a number
    // missing/invalid, backgroundLimit > size, or a stray third field — is genuine
    // corruption, and loud.
    const parts = raw.trim().split(":");
    const s = parseInt(parts[0] ?? "", 10);
    const bg = parts.length === 1 ? s : parseInt(parts[1] ?? "", 10);
    if (
      parts.length > 2 ||
      !Number.isInteger(s) ||
      s < 1 ||
      !Number.isInteger(bg) ||
      bg < 1 ||
      bg > s
    ) {
      throw new Error(
        `createHostSemaphore(${name}): corrupt size sentinel ${JSON.stringify(raw)}`,
      );
    }
    return { size: s, backgroundLimit: bg };
  }

  // Always writes the DECLARED identity — the pair this process was built for is the
  // only one it can legitimately claim authorship of. Called only where claiming it is
  // legal: a first touch, or a resize of a pool proven idle. An adoption never writes.
  function writeSentinelAtomic(): void {
    const path = sizeFile();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${declaredSize}:${declaredBackgroundLimit}`);
    renameSync(tmp, path);
    size = declaredSize;
    backgroundLimit = declaredBackgroundLimit;
  }

  // Cheap agreement test first: when the live sentinel already names the DECLARED pair
  // there is nothing to reconcile, so the steady state is one small read — no guard, no
  // probe, no subprocess.
  //
  // The test is against the declared pair, NOT the pair currently being swept. An
  // adopted instance disagrees with its own declaration by construction, so it re-runs
  // the guarded reconcile on every acquire — which is exactly what lets the declared
  // pair land the moment the pool goes idle. Comparing against the adopted pair instead
  // would make an adoption permanent for the instance's whole life, so a long-lived
  // backend that adopted once during a rolling change would never converge.
  //
  // Concurrent in-process callers share the in-flight run; the memo clears on settle so
  // the next acquire re-reads rather than trusting a stale outcome.
  //
  // DELIBERATELY NOT CANCELLABLE, and the reason is the memo. This run is SHARED:
  // threading one caller's `AbortSignal` into it would abort it for every other
  // caller that joined the same promise, and racing the signal against it instead
  // would abandon a promise whose later failure then has no owner. Neither is a
  // trade worth making here, because a caller parked in the reconcile is holding
  // NOTHING host-wide — the probe fds are closed inside the synchronous section and
  // the guard fd is closed before the guard child is spawned — so there is no host
  // resource for a cancellation to hand back. Its only wait is for `.size.lock`,
  // which is held across a handful of filesystem syscalls by a process doing a
  // first touch or a resize, never across a slot wait, and which flock releases
  // outright if that process dies. `acquireShare` therefore brackets it with
  // `throwIfAborted()` on both sides: an abort that lands during the reconcile
  // stops the call before it starts sweeping for a slot.
  function ensureSizeIdentity(): Promise<void> {
    const live = readSentinel();
    if (
      live !== undefined &&
      live.size === declaredSize &&
      live.backgroundLimit === declaredBackgroundLimit
    ) {
      size = declaredSize;
      backgroundLimit = declaredBackgroundLimit;
      return Promise.resolve();
    }
    if (!reconcile) {
      reconcile = doEnsureSizeIdentity().finally(() => {
        reconcile = undefined;
      });
    }
    return reconcile;
  }

  async function doEnsureSizeIdentity(): Promise<void> {
    slots.ensure();

    // Take the size guard. Non-blocking in-process first; if it's contended, another
    // process is mid-initialization — that is a benign flock race, NOT a broken
    // invariant, so we WAIT for the guard via one `flock-wait` child (the turnstile
    // pattern) rather than crash. A blocking in-process flock is banned (freezes the
    // loop) and polling is banned; the child does the blocking wait off our loop.
    const guard = guardFile();
    const guardFd = openSync(guard, "w");
    let guardHeld: HeldFlock | undefined;
    if (!flockTry(guardFd)) {
      closeSync(guardFd);
      guardHeld = await waitForFlock(guard);
    }
    const releaseGuard = async (): Promise<void> => {
      if (guardHeld) {
        await guardHeld.release();
      } else {
        closeSync(guardFd);
      }
    };

    try {
      // Re-read the sentinel AFTER the guard is genuinely held — the process we
      // queued behind may have just written it.
      const sentinel = readSentinel();
      if (sentinel === undefined) {
        // First process to touch this pool — record its size:split identity.
        writeSentinelAtomic();
      } else if (
        sentinel.size !== declaredSize ||
        sentinel.backgroundLimit !== declaredBackgroundLimit
      ) {
        // Mismatch on EITHER axis against what this process was built for. Claiming
        // the declared pair is safe ONLY if the pool is idle: LOCK_NB-sweep every slot
        // across both sizes. If any is held, an out-of-identity process is live.
        const hi = Math.max(sentinel.size, declaredSize);
        const probeFds: number[] = [];
        let allFree = true;
        for (let i = 0; i < hi; i++) {
          const fd = openSync(slotFile(i), "w");
          probeFds.push(fd);
          if (!flockTry(fd)) {
            allFree = false;
            break;
          }
        }
        if (!allFree) {
          for (const fd of probeFds) closeSync(fd);
          // Live pool, different pair → ADOPT the live one for this instance.
          //
          // The pool's identity is host state, not a per-process belief, and this
          // process is not entitled to overrule it. Every holder is sweeping the
          // sentinel's slot set, so joining them is the one choice under which the
          // bound holds and the reserved floor sits where everyone else thinks it does;
          // imposing the declared pair here is exactly the silent overcommit / floor
          // break the sentinel exists to prevent.
          //
          // This is NOT a fault to fail on. The host runs many checkouts at once and a
          // pool's size is derived from code, so any commit that moves the budget makes
          // every OTHER checkout's live pool "wrong" — a normal, transient, and
          // self-resolving condition. It used to throw here, which turned one such
          // commit into a host-wide outage: every build on the box died at its first
          // host grant, in both directions, until the pool happened to be idle at the
          // right instant. The declared pair still takes effect — the next acquire that
          // finds the pool idle writes it (the branch below) — it just no longer costs
          // an outage to get there.
          if (
            size !== sentinel.size ||
            backgroundLimit !== sentinel.backgroundLimit
          ) {
            console.warn(
              `createHostSemaphore(${name}): pool is live at ` +
                `${sentinel.size}:${sentinel.backgroundLimit} but this process was built for ` +
                `${declaredSize}:${declaredBackgroundLimit} — adopting the live identity ` +
                `(the declared one applies once the pool is idle).`,
            );
          }
          size = sentinel.size;
          backgroundLimit = sentinel.backgroundLimit;
        } else {
          // Pool idle → claim the declared pair, drop the now-extra slot files (only
          // when shrinking `size`), release every probe fd.
          writeSentinelAtomic();
          for (let i = declaredSize; i < sentinel.size; i++) {
            rmSync(slotFile(i), { force: true });
          }
          for (const fd of probeFds) closeSync(fd);
        }
      } else {
        // The sentinel names the declared pair — this instance may have been sweeping
        // an adopted one; the pool has since converged back.
        size = declaredSize;
        backgroundLimit = declaredBackgroundLimit;
      }
    } finally {
      await releaseGuard();
    }
  }

  // Non-blocking sweep over the lane's `order` window: open each slot fd in order,
  // `flock(LOCK_NB)` it, and KEEP the first `limit` fds that lock (the caller owns and
  // must close them to release). Every other fd — past the limit, or one that failed
  // to lock — is closed immediately. All in-process microsecond syscalls; never
  // freezes the loop the way LOCK_EX would. Slots OUTSIDE `order` (e.g. the reserved
  // floor for a background caller) are never opened, so they are structurally
  // unreachable. `limit === 0` locks nothing and returns [].
  function sweepKeep(limit: number, order: number[]): number[] {
    slots.ensure();
    const kept: number[] = [];
    for (const i of order) {
      const fd = openSync(slotFile(i), "w");
      if (kept.length < limit && flockTry(fd)) {
        kept.push(fd);
      } else {
        closeSync(fd);
      }
    }
    return kept;
  }

  // Fan out over the lane's `order` window: spawn one child per slot in that window,
  // take the FIRST to grant (any freed slot in the window wakes us), then SIGKILL and
  // reap the losers. Confining the children to `order` is what keeps a background
  // waiter off the reserved floor even on the slow path. SIGKILL cannot be caught;
  // process death cancels a blocked flock, and a loser that had already grabbed a
  // *different* slot releases it by dying. Awaiting `exited` is mandatory — it reaps
  // the zombies AND guarantees their slots are back before the caller re-sweeps for
  // extras.
  async function fanOut(
    order: number[],
    signal: AbortSignal | undefined,
  ): Promise<HeldFlock> {
    signal?.throwIfAborted();
    // One `waitForFlock` per slot, all sharing one signal: the caller's, plus our
    // own "the race is over" abort for the losers. Cancellation is expressed as
    // that abort KILLING the losers' children (inside `waitForFlock`), never as
    // racing the signal against `Promise.any` — racing would walk away from
    // pending stream reads whose later rejections have no owner.
    const losers = new AbortController();
    const waitSignal = signal
      ? AbortSignal.any([signal, losers.signal])
      : losers.signal;
    const waits = order.map((i) =>
      waitForFlock(slotFile(i), { signal: waitSignal }),
    );

    let winner: HeldFlock;
    try {
      // Settles on the first SUCCESS; rejects (AggregateError) only if EVERY
      // wait failed — all killed by the caller's abort, or all children died.
      winner = await Promise.any(waits);
    } catch (err) {
      // Every wait has settled (that is what made `Promise.any` reject), and
      // each one reaped its own child before rejecting — nothing to clean up.
      signal?.throwIfAborted();
      // Every fan-out child died before granting — loud, never a silent bound drop.
      throw new Error(
        `createHostSemaphore(${name}): all ${order.length} fan-out children exited before granting a slot`,
        { cause: err },
      );
    }

    // Kill the losers and wait for every wait to settle. Awaiting them is
    // mandatory — each one reaps its child before settling, and that is what
    // guarantees their slots are back before the caller re-sweeps for extras. A
    // loser that ALSO won (granted in the same turn) hands its slot straight back.
    losers.abort();
    const settled = await Promise.allSettled(waits);
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value !== winner)
        await s.value.release();
    }
    // A grant that lands in the same turn as the caller's abort: hand the
    // winner's slot back and throw rather than return a share nothing will use.
    if (signal?.aborted) {
      await winner.release();
      signal.throwIfAborted();
    }
    return winner;
  }

  // ── The demand gate (`Priority`) ────────────────────────────────────────────
  //
  // A `normal` waiter holds `demand.lock` SHARED for as long as it waits; a `low`
  // acquire takes it EXCLUSIVE to learn "nobody is waiting". flock grants a
  // shared request whenever no exclusive holder exists, so a pending exclusive
  // wait never delays a `normal` waiter's announcement.

  // Announce demand for the duration of a `normal` wait. Non-blocking in-process
  // first; it can only fail while a `low` acquire momentarily holds the lock
  // exclusive (its probe, or its gate's grant before the release), so the
  // fallback child is granted within milliseconds.
  async function holdDemand(
    signal: AbortSignal | undefined,
  ): Promise<() => Promise<void>> {
    slots.ensure();
    const fd = openSync(demandFile(), "w");
    if (flockTryShared(fd)) {
      return () => {
        closeSync(fd);
        return Promise.resolve();
      };
    }
    closeSync(fd);
    const held = await waitForFlock(demandFile(), { shared: true, signal });
    return () => held.release();
  }

  // Is any `normal` acquire of this pool waiting right now? A non-blocking
  // exclusive try that releases immediately.
  function demandPresent(): boolean {
    slots.ensure();
    const fd = openSync(demandFile(), "w");
    try {
      return !flockTry(fd);
    } finally {
      closeSync(fd);
    }
  }

  // Block (push-based, off the loop) until no `normal` acquire is waiting.
  async function awaitNoDemand(signal: AbortSignal | undefined): Promise<void> {
    const held = await waitForFlock(demandFile(), { signal });
    await held.release();
  }

  /** What one acquisition holds: fds swept in-process, plus a fan-out winner. */
  interface Taken {
    fds: number[];
    winner: HeldFlock | undefined;
  }

  // Hand back everything `taken` holds, synchronously (see `HostShare.releaseSlots`).
  function releaseTakenSync(taken: Taken): void {
    for (const fd of taken.fds) closeSync(fd);
    // Signals the child holding the winner's slot; it exits, its fd closes and
    // the flock releases. The async release below reaps it.
    taken.winner?.releaseSync();
  }

  async function releaseTaken(taken: Taken): Promise<void> {
    releaseTakenSync(taken);
    if (taken.winner) await taken.winner.release();
  }

  // One acquisition of `1 … effectiveMax` slots over the lane's `order` window:
  // the fast-path sweep, else the turnstile + fan-out. A `normal` caller holds
  // the demand lock shared across its slow path, so a `low` caller yields to it.
  async function takeSlots(
    effectiveMax: number,
    order: number[],
    priority: Priority,
    signal: AbortSignal | undefined,
    onWaitStart: () => void,
  ): Promise<Taken> {
    // Fast path: non-blocking sweep over the lane window for up to `effectiveMax`
    // slots. On a window with any free slot this is the whole story — no turnstile,
    // no subprocess.
    let fds = sweepKeep(effectiveMax, order);
    let winner: HeldFlock | undefined;
    if (fds.length > 0) return { fds, winner };

    // Slow path: every slot is busy (sweepKeep closed all fds it opened).
    onWaitStart();
    waiting++;
    // (a) Turnstile — only the head waiter fans out host-wide. Declared BEFORE
    // it is taken, with its release closure alongside, so that a cancellation
    // landing anywhere from the `openSync` onward unwinds through one `finally`
    // that closes the fd and reaps the child. (It used to be declared between
    // the acquire and the use, which left the child unreachable from a `finally`
    // for exactly the window an abort could land in.)
    const turnstile = turnstileFile();
    let turnstileFd: number | undefined;
    let turnstileHeld: HeldFlock | undefined;
    let turnstileReleased = false;
    const releaseTurnstile = async (): Promise<void> => {
      if (turnstileReleased) return;
      turnstileReleased = true;
      if (turnstileFd !== undefined) closeSync(turnstileFd);
      // Idempotent and reaps the holding child; a cancelled wait never
      // produced one (`waitForFlock` reaped it before throwing).
      if (turnstileHeld) await turnstileHeld.release();
    };
    let releaseDemand: (() => Promise<void>) | undefined;

    try {
      // A `normal` waiter announces itself before queueing, so every `low`
      // acquire from here on yields to it.
      if (priority === "normal") releaseDemand = await holdDemand(signal);
      // Take it non-blocking in-process; if contended, wait for it via a single
      // child (a turnstile is one file, so an ordinary flock queue on it can't
      // strand).
      turnstileFd = openSync(turnstile, "w");
      if (!flockTry(turnstileFd)) {
        closeSync(turnstileFd);
        turnstileFd = undefined;
        turnstileHeld = await waitForFlock(turnstile, { signal });
      }

      // (b) Re-sweep the lane window: a slot may have freed while we queued for
      // the turnstile.
      fds = sweepKeep(effectiveMax, order);
      if (fds.length === 0) {
        // (c) Fan out over the lane's window and take the first grant; (d) reap
        // the losers so their slots are back.
        winner = await fanOut(order, signal);
        // (d') Release the turnstile so the next waiter can fan out, BEFORE we
        // (e) re-sweep for up to `effectiveMax - 1` EXTRA slots. The winner's own
        // slot is held by the winner child, so it fails to lock here and is never
        // double-counted.
        await releaseTurnstile();
        fds = sweepKeep(effectiveMax - 1, order);
      }
    } finally {
      // Decremented FIRST, synchronously: a throwing `releaseTurnstile` must
      // never leave the queue-depth gauge permanently inflated.
      waiting--;
      // Covers the (b)-success path, any throw from fanOut, and a cancellation
      // anywhere in between — never strand the turnstile.
      await releaseTurnstile();
      // No longer waiting: stop holding `low` acquires back.
      if (releaseDemand) await releaseDemand();
    }
    return { fds, winner };
  }

  async function acquireShare(
    max: number,
    hooks?: AcquireHooks,
  ): Promise<HostShare> {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(
        `acquireShare: max must be a positive integer, got ${max}`,
      );
    }
    const signal = hooks?.signal;
    // First line, mirroring `spawnCaptured`: a caller that has already been told
    // to stop never opens a new wait, and never takes a slot it would only have
    // to hand straight back.
    signal?.throwIfAborted();
    const lane: Lane = hooks?.lane ?? "background";
    const priority: Priority = hooks?.priority ?? "normal";
    const t0 = performance.now();
    await ensureSizeIdentity();
    // The reconcile itself is deliberately not cancellable (see its docblock) —
    // it holds nothing host-wide. Re-check on the way out so an abort that landed
    // during it stops here, before we start sweeping for a slot.
    signal?.throwIfAborted();
    // AFTER the reconcile, never before: it is what settles which slot set this
    // acquire is entitled to sweep, so a window derived ahead of it could aim at the
    // wrong indices for the whole call.
    const order = laneOrder(lane);
    // Asking for more slots than the lane's window holds can't beat its ceiling —
    // clamp to the window size (`backgroundLimit` for background, `size` for
    // interactive) so the fast-path sweep and the extras re-sweep agree on the bound.
    const effectiveMax = Math.min(max, order.length);

    // `onWaitStart` fires once per acquire, however many times a `low` acquire
    // goes back to waiting.
    let waitStarted = false;
    const onWaitStart = (): void => {
      if (waitStarted) return;
      waitStarted = true;
      hooks?.onWaitStart?.();
    };

    let taken: Taken;
    if (priority === "normal") {
      taken = await takeSlots(
        effectiveMax,
        order,
        priority,
        signal,
        onWaitStart,
      );
    } else {
      for (;;) {
        // (1) Never start while a `normal` acquire is waiting.
        if (demandPresent()) {
          onWaitStart();
          waiting++;
          try {
            await awaitNoDemand(signal);
          } finally {
            waiting--;
          }
        }
        // (2) Take slots like anyone else (barging and all) …
        taken = await takeSlots(
          effectiveMax,
          order,
          priority,
          signal,
          onWaitStart,
        );
        // (3) … unless a `normal` acquire started waiting meanwhile — most often
        // while we were fanned out for this very slot. Hand it straight back and
        // go back to (1): the `normal` waiter's fan-out takes it.
        if (!demandPresent()) break;
        onWaitStart();
        await releaseTaken(taken);
        signal?.throwIfAborted();
      }
    }

    let released = false;
    // The synchronous half: once this returns, every slot is back host-wide.
    // Closing a kept fd releases its slot (flock auto-release), and killing the
    // winner child releases the one it holds, because flock releases on process
    // DEATH — the reap below is hygiene, not the bound. Split out so an abort
    // listener, which cannot await, can still hand the slots back inside the
    // abort event. See `HostShare.releaseSlots`.
    const releaseSlots = (): void => {
      // Idempotent: a caller may release in a `finally` that also runs on a path
      // where it already released. Guard so the second call is a no-op.
      if (released) return;
      released = true;
      releaseTakenSync(taken);
    };
    const release = async (): Promise<void> => {
      releaseSlots();
      // Reap the killed child. Awaiting a settled `exited` is a no-op, so calling
      // `release()` again — or calling it after an abort listener already ran
      // `releaseSlots()` — stays idempotent.
      if (taken.winner) await taken.winner.release();
    };

    if (signal?.aborted) {
      // We hold the slots, but the caller was abandoned somewhere between the last
      // wait and here. Hand them back and throw rather than return a share to an
      // owner that has stopped running and will never release it. This is the same
      // edge `SpawnBound.signal` documents — "an abort after a clean exit still
      // throws, discarding a good result" — with the extra reason that here the
      // discarded result is a host-wide resource.
      //
      // Before `onAcquired`, deliberately: a cancelled acquire must not report an
      // acquisition it is about to undo.
      await release();
      signal.throwIfAborted();
    }

    hooks?.onAcquired?.(performance.now() - t0);

    // slots = (the winner child's one slot, if we took the slow path) + the fds we
    // hold directly. Always >= 1: on the fast path fds.length >= 1 (we only fall to
    // the slow path when it's 0); on the slow path the winner contributes the 1.
    return {
      slots: (taken.winner ? 1 : 0) + taken.fds.length,
      release,
      releaseSlots,
    };
  }

  return {
    depth: () => waiting,

    liveSize: () => size,

    acquireShare,

    async run<T>(fn: () => Promise<T>, hooks?: AcquireHooks): Promise<T> {
      const share = await acquireShare(1, hooks);
      const signal = hooks?.signal;
      // Effect 2 of `AcquireHooks.signal`: stop HOLDING the host slot the moment
      // the body is abandoned, without waiting for it to settle. `releaseSlots` is
      // synchronous precisely so it can run here — an event listener cannot await —
      // and it is what turns "we gave up on this handler" into an actual flock
      // release on every other backend's behalf, rather than an entry in a ledger.
      //
      // What this does NOT do is cancel `fn`. There is no way to un-await a
      // promise; `fn` holds the same signal and owns its own cancellation. All we
      // are doing is declining to occupy a host slot on behalf of work that has
      // been written off. A body that ignores its signal keeps running — it just
      // no longer costs the host a slot while it does.
      //
      // Safe because release is idempotent: the `finally` still runs when `fn`
      // eventually settles, where it is a no-op for the slots and does the reap
      // this listener could not await.
      const onAbort = (): void => share.releaseSlots();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await fn();
      } finally {
        // Removed unconditionally: without this, a long-lived signal (a job's
        // `ctx.signal` outliving one gate acquire) would accumulate a listener per
        // call for the life of the dispatch.
        signal?.removeEventListener("abort", onAbort);
        await share.release();
      }
    },
  };
}
