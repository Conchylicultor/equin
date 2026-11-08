import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  crashFieldsOf,
  type CrashFields,
} from "@plugins/packages/plugins/error-subject/core";
import { type FSWatcher, watch } from "node:fs";
import { mkdir, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { readFile, stat } from "@plugins/packages/plugins/timed-fs/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import { duressLatchDir } from "../../data-dirs";

// Host-global duress latch: a single sentinel process (the cluster sentinel's
// worker thread on main) declares "the box is in trouble" by writing a file;
// every backend's observability choke points gate on it. The file is the
// cross-process channel on purpose — no DB, no sockets — so it stays readable
// even when everything else is wedged.
//
// Liveness is carried by the file's mtime, not its existence: duress holds only
// while the mtime is fresh (< FRESHNESS_LEASE_MS). The sentinel must refresh
// every tick while tripped; if it crashes, the lease lapses and the fleet
// self-recovers instead of shedding forever.
//
// No call here touches the disk synchronously: the hot gate (isUnderDuress /
// duressEpisode) answers from an in-process copy of the latch — its payload and
// mtime — that a watch on the latch's directory keeps current (see `held`
// below), and every read and write is async.

/** Latch mtime older than this ⇒ the sentinel stopped refreshing ⇒ duress lapsed. */
export const FRESHNESS_LEASE_MS = 60_000;

/**
 * After the watch failed to open or broke, the soonest a gate read opens it
 * again. Bounds the retries to the gate's own reads (no timer) without letting
 * a persistent failure (EMFILE while the box is out of descriptors) turn every
 * hot-path read into a mkdir + watch attempt and a report.
 */
const REARM_AFTER_MS = 5_000;

export const LATCH_FILENAME = "duress.latch";

export interface DuressLatch {
  /** Epoch ms when the current episode was declared. */
  setAt: number;
  /** Human-readable trip cause, for diagnostics/UI. */
  reason: string;
}

/** The latch file as read: its payload, and whether its lease is fresh. */
export interface DuressReading {
  latch: DuressLatch;
  /** The mtime is younger than FRESHNESS_LEASE_MS: duress holds. */
  fresh: boolean;
}

/** The latch file as this process last saw it. */
type LatchFile =
  { kind: "absent" } | { kind: "present"; latch: DuressLatch; mtimeMs: number };

// Null ⇒ the declared `locks/duress` directory. Only a test overrides it, and
// it is resolved per call rather than frozen at module eval, because
// `DataDir.path` is a getter over an env-overridable root (see its docblock).
let latchDirOverride: AppPath | null = null;
let now: () => number = Date.now;

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

function isFresh(mtimeMs: number): boolean {
  return now() - mtimeMs < FRESHNESS_LEASE_MS;
}

/** One async read of the latch file: stat (the lease) then the payload. */
async function readLatchFile(): Promise<LatchFile> {
  const path = latchPath();
  let mtimeMs: number;
  let raw: string;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
    raw = await readFile(path, "utf8");
  } catch (err) {
    // Absent, or cleared between the stat and the read: no latch.
    if (isEnoent(err)) return { kind: "absent" };
    throw err;
  }
  return { kind: "present", latch: JSON.parse(raw) as DuressLatch, mtimeMs };
}

// ── The held copy: what the synchronous gate answers from ──────────────────
//
// `null` until the first read of the file lands — not known yet. The gate
// answers "not under duress" then (see isUnderDuress); a backend never sees
// that window from a plugin hook, because this plugin's `onReadyBlocking`
// awaits the first read (`watchDuress`) before any dependent's hook runs.
//
// Kept current two ways:
//  - this process's own writes (set / refresh / clear) set it as they land, so
//    the writer — and a test — reads its own write at once;
//  - a watch on the latch's directory re-reads the file on every change to it,
//    for the writes of every other process and thread (the sentinel's worker).
// A lapse needs no event at all: the held mtime against the clock says when
// the lease ran out, so a sentinel that died mid-episode is noticed on time.
//
// A MISSED event (FSEvents can drop one — the process's shared stream restarts
// whenever any directory watch in it opens or closes) is bounded without a
// poll: a missed set is heard at the sentinel's next refresh (it bumps the
// mtime every tick while tripped, each a fresh event), and a missed clear
// holds no longer than the lease, which then lapses on the clock.
let held: LatchFile | null = null;

/** Bumped by each own write: a read that started before one is discarded. */
let writeGen = 0;
/**
 * The watch on the latch's directory, once armed: `watcher` is null while the
 * directory is still being minted; `ready` resolves once the held copy is read.
 */
let watching: {
  dir: AppPath;
  watcher: FSWatcher | null;
  ready: Promise<void>;
} | null = null;
/** Resolved after each read the watch applied (test seam). */
let readWaiters: (() => void)[] = [];

/** When the watch last failed to open or broke; null while it holds. */
let watchFailedAt: number | null = null;

/** A failure of the latch's own machinery, as {@link duressLatchFaultSink} carries it. */
export type DuressLatchFault = { message: string } & CrashFields;

/**
 * Where the latch's own failures go. A held report sink rather than the
 * server-core reporter: the latch is a leaf every env-independent process
 * imports (the CLI, the sentinel's worker thread — whose closure may not reach
 * server-core, `sentinel:worker-closure-lean`), so it cannot name the backend's
 * reporter. The latch's `machine/` half — loaded only by a desktop backend —
 * attaches it to `reportServerError`; elsewhere the stderr line is the record.
 */
export const duressLatchFaultSink = defineReportSink<DuressLatchFault>();

/**
 * A failure of the latch's own machinery (the watch, a re-read), reported and
 * survived — never thrown out of the process: the latch directory is shared by
 * every backend on the host, so one bad file or watch event would otherwise
 * take them all down at the same instant. The gate keeps the copy it holds
 * (its lease still judged against the clock) and the next gate read re-arms.
 */
function reportLatchFailure(what: string, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const message = `duress latch: ${what}: ${error.message}`;
  console.error(`[duress-latch] ${message}`, error);
  duressLatchFaultSink.emit({
    message,
    ...crashFieldsOf(error),
  });
}

const reread = createCoalescer({
  run: async () => {
    const gen = writeGen;
    try {
      const file = await readLatchFile();
      // An own write landed while this read was in flight: it is newer than
      // whatever the read saw, and its own watch event re-reads after it.
      if (gen === writeGen) held = file;
    } catch (err) {
      // A corrupt or unreadable latch: keep the held copy, say so.
      reportLatchFailure("re-reading the latch file failed", err);
    }
    const waiters = readWaiters;
    readWaiters = [];
    for (const resolve of waiters) resolve();
  },
});

/**
 * Open the watch on the latch's directory (idempotent) and resolve once the
 * held copy has been read from disk. The watch is opened BEFORE that read, so
 * no change can fall between them.
 */
function arm(): Promise<void> {
  const dir = latchDir();
  if (watching?.dir === dir) return watching.ready;
  disarm();
  const entry: NonNullable<typeof watching> = {
    dir,
    watcher: null,
    ready: Promise.resolve(),
  };
  watching = entry;
  entry.ready = openWatch(entry).catch((err: unknown) => {
    // A failed mkdir or watch() (EMFILE under descriptor pressure — exactly
    // when duress matters) must not leave an entry that looks armed: the gate
    // would answer from a copy nothing updates. Drop it, so a later gate read
    // retries, and report it. Never rejects: boot (onReadyBlocking) survives
    // it with the gate on its held copy.
    failWatch(entry);
    reportLatchFailure("opening the watch on the latch directory failed", err);
  });
  return entry.ready;
}

/** The watch failed: drop it, and let a gate read re-arm after REARM_AFTER_MS. */
function failWatch(entry: NonNullable<typeof watching>): void {
  if (watching !== entry) return; // already replaced (re-pointed, re-armed)
  disarm();
  watchFailedAt = now();
}

async function openWatch(entry: NonNullable<typeof watching>): Promise<void> {
  // `fs.watch` throws ENOENT on a missing directory, and the directory
  // appears only with the first episode — mint it so the watch can hear it.
  await mkdir(entry.dir, { recursive: true });
  if (watching !== entry) return; // re-pointed (a test) while minting
  // Not persistent: the watch must never keep a process (a test run, a
  // worker) alive on its own.
  const watcher = watch(
    entry.dir,
    { persistent: false },
    (_event, filename) => {
      // A null filename is a platform edge: re-read, it costs one stat.
      if (filename === null || filename === LATCH_FILENAME) reread.trigger();
    },
  );
  entry.watcher = watcher;
  // The watch is the gate's only way to learn of another process's write;
  // losing it silently would freeze the held copy. Drop it (a later gate read
  // re-arms and re-reads) and report it — never crash: see reportLatchFailure.
  watcher.on("error", (err) => {
    failWatch(entry);
    reportLatchFailure("the watch on the latch directory broke", err);
  });
  watchFailedAt = null;
  await reread.run();
}

/** Close the watch. The held copy stays: the next arm re-reads over it. */
function disarm(): void {
  const w = watching;
  watching = null;
  w?.watcher?.close();
}

/**
 * Start following the latch: open the watch on its directory and read it once.
 * Resolves once the gate answers from the file rather than from not-known-yet.
 * A backend runs it in this plugin's `onReadyBlocking`; any other process
 * starts it with its first gate read.
 */
export function watchDuress(): Promise<void> {
  return arm();
}

// ── Writers: the sentinel only ─────────────────────────────────────────────

/**
 * Declare a duress episode: create (or overwrite) the latch, and return what
 * was written — its `setAt` is the episode's identity. Written to a temp file
 * and renamed into place, so a reader woken mid-write never parses half a
 * payload. Writer: the sentinel only.
 */
export async function setDuress(reason: string): Promise<DuressLatch> {
  const dir = latchDir();
  await mkdir(dir, { recursive: true });
  const latch: DuressLatch = { setAt: now(), reason };
  const tmp = joinAppPath(dir, `${LATCH_FILENAME}.${String(process.pid)}.tmp`);
  await writeFile(tmp, JSON.stringify(latch));
  // The lease starts at `setAt`, on the file as in the held copy (a rename
  // keeps the mtime it is given).
  await utimes(tmp, new Date(latch.setAt), new Date(latch.setAt));
  await rename(tmp, latchPath());
  writeGen += 1;
  held = { kind: "present", latch, mtimeMs: latch.setAt };
  return latch;
}

/**
 * Renew the freshness lease by bumping the latch's mtime. The sentinel calls
 * this every tick while tripped. Throws if the latch is absent: the sentinel
 * owns the set → refresh → clear lifecycle, so refreshing a latch that was
 * never set (or already cleared) is a lifecycle bug, not a state to absorb.
 */
export async function refreshDuress(): Promise<void> {
  const t = now();
  try {
    await utimes(latchPath(), new Date(t), new Date(t));
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error(
        `refreshDuress: no latch at ${latchPath()} — refresh without a prior setDuress is a lifecycle bug`,
      );
    }
    throw err;
  }
  writeGen += 1;
  // The payload is unchanged by a refresh; only a held copy can be renewed.
  if (held?.kind === "present") held = { ...held, mtimeMs: t };
  else reread.trigger();
}

/** End the episode. Idempotent — clearing an already-clear latch is legitimate. */
export async function clearDuress(): Promise<void> {
  try {
    await unlink(latchPath());
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  writeGen += 1;
  held = { kind: "absent" };
}

// ── The synchronous gate: hot paths ────────────────────────────────────────

/** The held copy, starting the watch on first use (and again after it failed). */
function heldLatch(): LatchFile | null {
  if (
    watching?.dir !== latchDir() &&
    (watchFailedAt === null || now() - watchFailedAt >= REARM_AFTER_MS)
  )
    void runTracked("duress-latch:watch", arm);
  return held;
}

/**
 * Is the host under duress right now? True only if the latch exists AND its
 * mtime is fresh (< FRESHNESS_LEASE_MS). Synchronous and free by contract —
 * called on observability hot paths from possibly-struggling event loops — so
 * it never touches the disk: it answers from the held copy, its lease judged
 * against the clock.
 *
 * Not known yet (before the first read of the file lands) answers `false`:
 * the gate's consumers then behave as they do on a calm host — persist the log
 * line, admit the write, leave the ledger's duress flag unset — for the few
 * milliseconds of one async stat, which is the state every process boots into
 * anyway. A backend's plugin hooks never see that window (`watchDuress` runs in
 * `onReadyBlocking`). A caller that must not act on a stale answer — one woken
 * by the latch, or a process that reads it once — awaits `readFreshDuress()`.
 */
export function isUnderDuress(): boolean {
  const file = heldLatch();
  return file?.kind === "present" && isFresh(file.mtimeMs);
}

/**
 * The current episode's identity (`setAt`), `null` when no latch file exists
 * (or none is known yet — see isUnderDuress). The shed engine consults it on
 * every admit while under duress; a `setAt` change is how readers detect a NEW
 * episode. Same held copy as isUnderDuress: never touches the disk.
 */
export function duressEpisode(): number | null {
  const file = heldLatch();
  return file?.kind === "present" ? file.latch.setAt : null;
}

// ── Fresh async reads ──────────────────────────────────────────────────────

/**
 * The latch read from disk now, for diagnostics and lifecycle decisions (the
 * sentinel adopting or closing a previous worker's episode). `null` when no
 * latch file exists; `fresh` says whether its lease holds.
 */
export async function readDuress(): Promise<DuressReading | null> {
  const file = await readLatchFile();
  if (file.kind === "absent") return null;
  return { latch: file.latch, fresh: isFresh(file.mtimeMs) };
}

/**
 * The latch payload only while its lease is fresh — the value isUnderDuress()
 * gates on, read from disk now rather than from the held copy. For a reader
 * woken by a change to the latch file (a watcher serving the state to a UI, the
 * CLI's admission valve): the held copy is refreshed by its own watch, which
 * may not have fired yet, and nothing would wake the reader again to correct
 * it. `null` when there is no latch or its lease lapsed.
 */
export async function readFreshDuress(): Promise<DuressLatch | null> {
  const reading = await readDuress();
  return reading?.fresh ? reading.latch : null;
}

// ── Test seams ─────────────────────────────────────────────────────────────

/** Point the latch at a temp dir (null restores the declared dir); drops the watch. */
export function _setLatchDirForTests(dir: AppPath | null): void {
  latchDirOverride = dir;
  disarm();
  watchFailedAt = null;
  // The held copy was another directory's; a read in flight is too.
  held = null;
  writeGen += 1;
}

/** Override the clock (lease math, setAt). Pass null to restore Date.now. */
export function _setClockForTests(clock: (() => number) | null): void {
  now = clock ?? Date.now;
}

/** Break the open watch as the platform would (its "error" event). */
export function _breakLatchWatchForTests(err: Error): void {
  const watcher = watching?.watcher;
  if (!watcher) throw new Error("no open latch watch to break");
  watcher.emit("error", err);
}

/** Resolves after the watch next re-reads the file — a write from "another process" landed. */
export function _nextLatchReadForTests(): Promise<void> {
  return new Promise((resolve) => readWaiters.push(resolve));
}
