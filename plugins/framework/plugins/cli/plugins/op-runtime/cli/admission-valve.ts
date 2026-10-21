import { closeSync, openSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import {
  duressLatchDir,
  FRESHNESS_LEASE_MS,
  isUnderDuress,
  LATCH_FILENAME,
  MEMO_TTL_MS,
  readDuress,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import {
  duressGuard,
  type DuressGuard,
} from "@plugins/debug/plugins/sentinel/plugins/status-file/core";
import {
  readSentinelWatch,
  sentinelStatusDir,
} from "@plugins/debug/plugins/sentinel/plugins/status-file/server";
import {
  flockTry,
  flockTryShared,
  waitForFlock,
} from "@plugins/packages/plugins/flock/core";
import {
  createTicketLine,
  type Ticket,
} from "@plugins/packages/plugins/ticket-line/core";
import type { Lane } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { agentBuildGateDir } from "../data-dirs";
import { buildProfilerStart } from "./profiler";

// The duress gate — how an agent build is admitted to its heavy section
// (research/2026-10-21-cli-duress-admission-one-at-a-time-v2.md).
//
// While the host duress latch is fresh (the cluster sentinel declared "the box
// is in trouble": compressor thrash, pg pressure, load), agent builds run ONE AT
// A TIME: a build is admitted only once no other agent build is running, in
// arrival order. While calm, any number run together. No timeout anywhere: some
// build always holds the gate and finishes, so the line always moves.
//
// The mechanism is one host-wide readers/writer flock, `gate.lock`:
//  - calm admission takes it SHARED — calm builds never exclude each other;
//  - duress admission takes it EXCLUSIVE — granted only once every running agent
//    build has released it, and it keeps every other agent build out until it
//    finishes;
//  - duress waiters queue for the exclusive lock in a first-come-first-served
//    `ticket-line`, so they are admitted in arrival order (a bare flock wakes an
//    arbitrary waiter).
// The kernel releases a flock with its holder's process, so a killed build never
// strands the gate.
//
// The caller takes the gate BEFORE its host CPU grant, so a build waiting here
// never sits on CPU slots it cannot use, and a gate holder's only wait is for a
// grant, whose holders always finish — deadlock-free. One race remains: a build
// admitted shared while calm can wait for its grant while duress trips. It must
// not then start beside the others, so once the grant is held the caller
// re-checks (`mustRequeue`) and, if duress is fresh, releases grant and gate and
// is admitted again — this time exclusively, which is never re-checked, so the
// loop terminates.
//
// Waiting on the latch is event-driven, never a poll loop: one fs.watch on the
// latch's own directory scoped to the latch filename (catches clearDuress's
// unlink AND refresh's mtime bump) plus a single computed deadline timer at
// latch mtime + FRESHNESS_LEASE_MS (the lease guarantees a stale latch
// self-clears, so the deadline is a real wake condition).
//
// The latch can only go up while the machine-trouble watcher is running. When
// it is not, the gate never goes exclusive, so a gated build first says so
// (`checkValveGuard`), read from the watcher's host-global status file. It
// never holds on that: a dead watcher must not stop every deploy. See
// research/2026-09-17-global-admission-valve-says-when-unguarded.md.

/**
 * Does the gate apply to this build? Only background-lane (agent) builds. The
 * interactive lane (main — a human is blocked) is never held, and per the
 * adopted v1 decision main's detached auto-build (SINGULARITY_BUILD_DETACHED,
 * spawned by build/run-build.ts) also passes. Push never reaches the gate —
 * it holds the reserved push slot, not a build grant.
 */
export function valveGates(
  lane: Lane,
  // Index-signature shape, not a named-prop literal: ProcessEnv declares no
  // named properties, so a weak object type here rejects `process.env` at
  // the production call site (TS2559).
  env: { readonly [key: string]: string | undefined },
): boolean {
  return lane === "background" && !env.SINGULARITY_BUILD_DETACHED;
}

/** How a build holds the gate: beside other calm builds, or alone. */
export type GateMode = "shared" | "exclusive";

/** The gate, held across the heavy section. */
export interface GateHold {
  readonly mode: GateMode;
  /** Idempotent. */
  release(): Promise<void>;
}

/**
 * Why a hold ended: `cleared` — admitted beside other calm builds (duress
 * cleared, or the exclusive build it waited for finished); `acquired` —
 * admitted alone under duress. Both are op-log `WaitResult`s.
 */
export type HoldResult = "cleared" | "acquired";

/** The gate's lock and line — real flocks in production, fakes under test. */
export interface GateLocks {
  /** Take the gate now, or `null` when a holder of the other mode excludes it. */
  tryLock(mode: GateMode): GateHold | null;
  /** Wait for the gate (push-based); throws `signal.reason` on abort. */
  waitLock(mode: GateMode, signal?: AbortSignal): Promise<GateHold>;
  /** Join the line of exclusive waiters; resolves at its head. */
  joinLine(signal: AbortSignal): Promise<Ticket>;
}

/**
 * Injected seams so the admission loop is pure logic under test (no real
 * latch, no flock, no timers). Production uses `createValveDeps()`.
 */
export interface ValveDeps {
  isUnderDuress(): boolean;
  /** Whether the machine watcher is running to raise the latch at all. */
  duressGuard(): DuressGuard;
  /** Latch trip cause for the hold line, null when unreadable/absent. */
  duressReason(): string | null;
  /**
   * Sleep until the latch plausibly changed (latch event or lease deadline).
   * Resolves early, never throws, when `signal` aborts. Event-driven — see the
   * module comment.
   */
  waitForWake(signal: AbortSignal): Promise<void>;
  gate: GateLocks;
  /** The build blocked at the gate; `reason` says on what. */
  onHoldStart(reason: string | null): void;
  onHoldEnd(result: HoldResult): void;
}

/** The hold reason while a calm build waits for an exclusive build to finish. */
export const EXCLUSIVE_RUNNING_REASON =
  "an agent build admitted under duress is running";

class DuressCleared extends Error {
  constructor() {
    super("duress cleared");
  }
}

/**
 * Admit a gated build to its heavy section: returns the gate, held, or `null`
 * when the build is not gated (nothing to hold). Blocks while duress keeps
 * another agent build running, in arrival order. Never times out.
 */
export async function admitThroughGate(
  opts: { gated: boolean },
  deps: ValveDeps = createValveDeps(),
): Promise<GateHold | null> {
  if (!opts.gated) return null;

  let holding = false;
  const holdStart = (reason: string | null): void => {
    if (holding) return;
    holding = true;
    deps.onHoldStart(reason);
  };
  const admitted = (hold: GateHold, result: HoldResult): GateHold => {
    if (holding) deps.onHoldEnd(result);
    return hold;
  };

  for (;;) {
    if (deps.isUnderDuress()) {
      holdStart(deps.duressReason());
      const alone = await exclusiveUnlessCleared(deps);
      if (alone) return admitted(alone, "acquired");
      continue;
    }
    let shared = deps.gate.tryLock("shared");
    if (!shared) {
      // A build admitted under duress is running: wait for it to finish.
      holdStart(EXCLUSIVE_RUNNING_REASON);
      shared = await deps.gate.waitLock("shared");
    }
    // Duress may have tripped while we waited: then this build runs alone,
    // after the ones already running — go round as a duress admission.
    if (deps.isUnderDuress()) {
      await shared.release();
      continue;
    }
    return admitted(shared, "cleared");
  }
}

/**
 * Under duress: wait in line, then for the exclusive lock — unless the latch
 * clears first (`null`: the caller goes round and is admitted shared).
 */
async function exclusiveUnlessCleared(
  deps: ValveDeps,
): Promise<GateHold | null> {
  const clear = new AbortController();
  const stopWatching = new AbortController();
  const watching = (async () => {
    while (!stopWatching.signal.aborted) {
      if (!deps.isUnderDuress()) {
        clear.abort(new DuressCleared());
        return;
      }
      await deps.waitForWake(stopWatching.signal);
    }
  })();
  try {
    const ticket = await deps.gate.joinLine(clear.signal);
    try {
      return (
        deps.gate.tryLock("exclusive") ??
        (await deps.gate.waitLock("exclusive", clear.signal))
      );
    } finally {
      ticket.leave();
    }
  } catch (err) {
    if (err instanceof DuressCleared) return null;
    throw err;
  } finally {
    stopWatching.abort();
    await watching;
  }
}

/**
 * The post-grant re-check: a build admitted SHARED while calm that now holds
 * its CPU grant under duress must not start beside the others — release grant
 * and gate and be admitted again (exclusively). An exclusive admission is never
 * re-checked: it is the one build allowed to run, which is what makes the
 * caller's retry loop terminate.
 */
export function mustRequeue(
  hold: GateHold | null,
  underDuress: boolean,
): boolean {
  return hold?.mode === "shared" && underDuress;
}

/**
 * Say when a gated build is unprotected: the machine watcher is not running, so
 * the latch cannot go up and the gate will never hold this build. Prints one
 * line and returns a short note for the build's verdict; `null` when the build
 * is not gated or the guard is on. Never holds.
 *
 * Ungated builds are skipped: they are never held anyway, and main's detached
 * auto-build runs exactly while main restarts — when the watcher is stopped on
 * purpose.
 */
export function checkValveGuard(
  opts: { gated: boolean },
  deps: Pick<ValveDeps, "duressGuard">,
): string | null {
  if (!opts.gated) return null;
  const guard = deps.duressGuard();
  if (guard.kind === "on") return null;
  console.log(
    `build admission: duress guard OFF (${guard.why}) — this build will not be held if the machine runs out of memory`,
  );
  return `duress guard off: ${guard.why}`;
}

/** Production deps: the real latch, the gate's flocks, fs.watch wake, span, console. */
export function createValveDeps(): ValveDeps {
  // One hold is always closed before the next opens (holds never nest), so a
  // single slot for the open span suffices.
  let endHoldSpan: (() => void) | undefined;
  return {
    isUnderDuress,
    duressGuard: () => duressGuard(readSentinelWatch(sentinelStatusDir.path)),
    duressReason: () => readDuress()?.reason ?? null,
    waitForWake: waitForLatchWake,
    gate: createGateLocks(agentBuildGateDir),
    onHoldStart: (reason) => {
      console.log(
        reason === EXCLUSIVE_RUNNING_REASON
          ? `build admission held: ${reason} — waiting for it to finish...`
          : `build admission held: host under duress${reason ? ` (${reason})` : ""} — waiting to run alone (agent builds run one at a time, in arrival order)...`,
      );
      endHoldSpan = buildProfilerStart(
        "duressHold",
        "build:queue",
        "held: host under duress",
      );
    },
    onHoldEnd: (result) => {
      endHoldSpan?.();
      endHoldSpan = undefined;
      console.log(
        result === "acquired"
          ? "build admission released: running alone while the host is under duress"
          : "build admission released: duress cleared",
      );
    },
  };
}

/** Where a gate keeps its lock and line — `agentBuildGateDir` in production. */
export interface GateDir {
  file(...segments: string[]): string;
  ensure(): string;
}

/** The gate's real flocks and ticket line, in `dir`. */
export function createGateLocks(dir: GateDir): GateLocks {
  const lockFile = (): string => dir.file("gate.lock");
  const hold = (mode: GateMode, release: () => Promise<void>): GateHold => {
    let released: Promise<void> | undefined;
    return { mode, release: () => (released ??= release()) };
  };
  return {
    tryLock(mode) {
      dir.ensure();
      const fd = openSync(lockFile(), "w");
      if (mode === "shared" ? flockTryShared(fd) : flockTry(fd)) {
        return hold(mode, () => {
          closeSync(fd);
          return Promise.resolve();
        });
      }
      closeSync(fd);
      return null;
    },
    async waitLock(mode, signal) {
      dir.ensure();
      const held = await waitForFlock(lockFile(), {
        shared: mode === "shared",
        signal,
      });
      return hold(mode, () => held.release());
    },
    joinLine: (signal) => createTicketLine(dir.file("line")).join({ signal }),
  };
}

/**
 * Sleep until the latch plausibly changed state: fs.watch on the latch's own
 * directory scoped to the latch filename, plus one deadline timer at latch
 * mtime + lease (+ε). When the latch is already gone or its lease already
 * lapsed, the latch's in-process stat memo may still report duress for up to
 * MEMO_TTL_MS — wait that long instead of spinning; the memo converges within
 * it. Spurious wakes are harmless (the caller re-checks); an abort resolves.
 */
function waitForLatchWake(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    // `fs.watch` throws ENOENT on a missing directory. The latch dir normally
    // exists by now (a live episode's `setDuress` created it), but a clear
    // between the duress check and this call could have left the CLI watching
    // nothing — so mint it rather than turn a benign race into a crashed build.
    const dir = duressLatchDir.ensure();
    let leaseLapsesInMs: number;
    try {
      leaseLapsesInMs =
        statSync(join(dir, LATCH_FILENAME)).mtimeMs +
        FRESHNESS_LEASE_MS +
        LEASE_EPSILON_MS -
        Date.now();
    } catch (err) {
      if (!(
        err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
      ))
        throw err;
      leaseLapsesInMs = 0; // latch vanished between check and stat
    }
    const waitMs = leaseLapsesInMs > 0 ? leaseLapsesInMs : MEMO_TTL_MS;

    const watcher = watch(dir, (_event, filename) => {
      // A null filename is a platform edge; wake and let the caller re-check.
      if (filename === null || filename === LATCH_FILENAME) done();
    });
    const timer = setTimeout(done, waitMs);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      watcher.close();
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Grace added to the lease deadline so the timer fires just after the lease
 * lapses, not racing it.
 */
const LEASE_EPSILON_MS = 500;
