import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import {
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { duressLatchDir } from "../../data-dirs";

// Host-global duress latch: a single sentinel process (the Phase-B cluster
// sentinel on main) declares "the box is in trouble" by writing a file; every
// backend's observability choke points read it synchronously and cheaply.
// The file is the cross-process channel on purpose — no DB, no sockets — so it
// stays readable even when everything else is wedged.
//
// Liveness is carried by the file's mtime, not its existence: duress holds only
// while the mtime is fresh (< FRESHNESS_LEASE_MS). The sentinel must refresh
// every tick while tripped; if it crashes, the lease lapses and the fleet
// self-recovers instead of shedding forever.

/** Latch mtime older than this ⇒ the sentinel stopped refreshing ⇒ duress lapsed. */
export const FRESHNESS_LEASE_MS = 60_000;
/** In-process stat memo — bounds isUnderDuress to ≤ 1 stat per process per window. */
export const MEMO_TTL_MS = 2_000;

export const LATCH_FILENAME = "duress.latch";

export interface DuressLatch {
  /** Epoch ms when the current episode was declared. */
  setAt: number;
  /** Human-readable trip cause, for diagnostics/UI. */
  reason: string;
}

// Null ⇒ the declared `locks/duress` directory. Only a test overrides it, and
// it is resolved per call rather than frozen at module eval, because
// `DataDir.path` is a getter over an env-overridable root (see its docblock).
let latchDirOverride: AppPath | null = null;
let now: () => number = Date.now;
let memo: { value: boolean; at: number } | null = null;
let episodeMemo: { value: number | null; at: number } | null = null;

function invalidateMemos(): void {
  memo = null;
  episodeMemo = null;
}

function latchDir(): AppPath {
  return latchDirOverride ?? duressLatchDir.path;
}

function latchPath(): AppPath {
  return joinAppPath(latchDir(), LATCH_FILENAME);
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Declare a duress episode: create (or overwrite) the latch. Writer: the sentinel only. */
export function setDuress(reason: string): void {
  mkdirSync(latchDir(), { recursive: true });
  const latch: DuressLatch = { setAt: now(), reason };
  writeFileSync(latchPath(), JSON.stringify(latch));
  invalidateMemos();
}

/**
 * Renew the freshness lease by bumping the latch's mtime. The sentinel calls
 * this every tick while tripped. Throws if the latch is absent: the sentinel
 * owns the set → refresh → clear lifecycle, so refreshing a latch that was
 * never set (or already cleared) is a lifecycle bug, not a state to absorb.
 */
export function refreshDuress(): void {
  const t = new Date(now());
  try {
    utimesSync(latchPath(), t, t);
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error(
        `refreshDuress: no latch at ${latchPath()} — refresh without a prior setDuress is a lifecycle bug`,
      );
    }
    throw err;
  }
  invalidateMemos();
}

/** End the episode. Idempotent — clearing an already-clear latch is legitimate. */
export function clearDuress(): void {
  try {
    unlinkSync(latchPath());
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  invalidateMemos();
}

/**
 * Is the host under duress right now? True only if the latch exists AND its
 * mtime is fresh (< FRESHNESS_LEASE_MS). Synchronous and cheap by contract —
 * called on observability hot paths from possibly-struggling event loops —
 * so it is one statSync at most once per MEMO_TTL_MS per process. ENOENT is
 * the normal "not under duress" state; any other fs error throws.
 */
export function isUnderDuress(): boolean {
  const t = now();
  if (memo !== null && t - memo.at < MEMO_TTL_MS) return memo.value;
  let value: boolean;
  try {
    value = t - statSync(latchPath()).mtimeMs < FRESHNESS_LEASE_MS;
  } catch (err) {
    if (!isEnoent(err)) throw err;
    value = false;
  }
  memo = { value, at: t };
  return value;
}

/**
 * The current episode's identity (`setAt`), `null` when no latch file exists.
 * Same hot-path contract as isUnderDuress — one file read at most once per
 * MEMO_TTL_MS per process, mutations invalidate — because Phase C's shed
 * engine consults it on every admit while under duress. A `setAt` change is
 * how readers detect a NEW episode; ≤ MEMO_TTL_MS staleness only delays a
 * first-N counter reset by that much.
 */
export function duressEpisode(): number | null {
  const t = now();
  if (episodeMemo !== null && t - episodeMemo.at < MEMO_TTL_MS)
    return episodeMemo.value;
  const value = readDuress()?.setAt ?? null;
  episodeMemo = { value, at: t };
  return value;
}

/**
 * The latch payload, for diagnostics/UI. `null` when no latch file exists.
 * Reads the file every call (not memoized, not freshness-gated) — this is the
 * cold diagnostic path, not the hot gate; use isUnderDuress() for gating.
 */
export function readDuress(): DuressLatch | null {
  let raw: string;
  try {
    raw = readFileSync(latchPath(), "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  return JSON.parse(raw) as DuressLatch;
}

/**
 * The latch payload only while its lease is fresh — the value isUnderDuress()
 * gates on, read now rather than from its memo. For a reader woken by a change
 * to the latch file (a watcher serving the state to a UI): the memo may still
 * hold the answer from before the change for up to MEMO_TTL_MS, and nothing
 * would wake the reader again to correct it. `null` when there is no latch or
 * its lease lapsed (the sentinel stopped refreshing it).
 */
export function readFreshDuress(): DuressLatch | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(latchPath()).mtimeMs;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  if (now() - mtimeMs >= FRESHNESS_LEASE_MS) return null;
  // Cleared between the stat and the read: no latch.
  return readDuress();
}

/** Point the latch at a temp dir. Pass null to restore the declared dir. */
export function _setLatchDirForTests(dir: AppPath | null): void {
  latchDirOverride = dir;
  invalidateMemos();
}

/** Override the clock (memo TTL + freshness math). Pass null to restore Date.now. */
export function _setClockForTests(clock: (() => number) | null): void {
  now = clock ?? Date.now;
  invalidateMemos();
}
