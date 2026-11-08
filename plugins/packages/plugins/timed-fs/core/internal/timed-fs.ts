import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

// The file reads every non-browser process makes, timed. A stalled disk used
// to read as the caller's own work: a 12 s `Bun.Glob` scan inside a live read
// was recorded as the read's own time, and nobody could tell from the record
// that the filesystem was the cause. Each call here keeps node's own name and
// type, so moving an import onto this module changes nothing but the timing —
// and every call past `FS_WAIT_FLOOR_MS` is handed to `onSlowFsCall`
// subscribers under a named wait layer, which the backend charges as a wait
// (runtime-profiler's server install) and every process writes down
// (`debug/profiling/fs-wait`).
//
// A LEAF: node builtins only. Every process imports it (the CLI bootstrap,
// file-sink, the profiler's own dependencies), so a single `@plugins/*` import
// here would close a cycle or pull a package into the bootstrap. Subscribers
// are installed from outside.

/**
 * The wait layers a file read is charged under — a closed set, so every
 * surface can name them. Metadata (`fs-stat`) is apart from listings and
 * reads: a host whose metadata calls stall shows one, a slow disk all of them.
 */
export const FS_WAIT_LAYERS = [
  "fs-stat",
  "fs-readdir",
  "fs-read",
  "fs-glob",
] as const;
export type FsWaitLayer = (typeof FS_WAIT_LAYERS)[number];

/**
 * The node:fs calls this module times, by the module they come from — what
 * the `timed-fs/no-untimed-fs-read` lint moves onto it. Callback forms are not
 * here: they are not used in this codebase's runtime code.
 */
export const TIMED_FS_CALLS = {
  promises: {
    readFile: "fs-read",
    readdir: "fs-readdir",
    stat: "fs-stat",
    lstat: "fs-stat",
    access: "fs-stat",
    realpath: "fs-stat",
    readlink: "fs-stat",
  },
  sync: {
    readFileSync: "fs-read",
    readdirSync: "fs-readdir",
    statSync: "fs-stat",
    lstatSync: "fs-stat",
    accessSync: "fs-stat",
    existsSync: "fs-stat",
    realpathSync: "fs-stat",
    readlinkSync: "fs-stat",
  },
} as const satisfies Record<
  "promises" | "sync",
  Readonly<Record<string, FsWaitLayer>>
>;

/**
 * A call is a wait worth naming from here on. Far above a healthy call (a stat
 * is microseconds, a listing of a big folder a few ms) and far below a stall
 * (seconds): a subscriber applies its own, higher bar on top.
 */
export const FS_WAIT_FLOOR_MS = 100;

/** One file call that took at least `FS_WAIT_FLOOR_MS`. */
export interface SlowFsCall {
  layer: FsWaitLayer;
  /** The call's node name (`readdir`, `statSync`, `scanGlob`). */
  op: string;
  ms: number;
  /**
   * What it read: the path (a descriptor as `fd:<n>`), a glob as
   * `<cwd>/<pattern>` — capped at 300 chars, `null` when it named none.
   */
  target: string | null;
  /** `Date.now()` when the call returned. */
  at: number;
  /**
   * Timed async calls of this process in flight as it started, itself
   * included. A large number says the wait was mostly a QUEUE — the call
   * waited behind the process's own reads for one of libuv's few fs threads
   * (a check reading 6,000 files at once) — not one slow disk answer.
   */
  concurrent: number;
}

type SlowFsHandler = (call: SlowFsCall) => void;

const handlers: SlowFsHandler[] = [];
// A subscriber's own file calls (a sink's size stat) are timed but never
// dispatched again, so a stall while one writes cannot recurse.
let dispatching = false;

/**
 * Subscribe to every file call of this process (this realm: a worker thread
 * has its own) that took at least `FS_WAIT_FLOOR_MS`. Called synchronously as
 * the call returns, before its caller resumes — so a subscriber that charges
 * the wait sees the caller's ambient context. A handler must not throw.
 * Returns the unsubscriber.
 */
export function onSlowFsCall(handler: SlowFsHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

const TARGET_CAP = 300;

function targetOf(arg: unknown): string | null {
  let s: string | null = null;
  if (typeof arg === "string") s = arg;
  else if (typeof arg === "number") s = `fd:${arg}`;
  else if (arg instanceof URL) s = arg.href;
  else if (arg instanceof Uint8Array) s = new TextDecoder().decode(arg);
  else if (arg !== null && typeof arg === "object" && "fd" in arg)
    s = `fd:${String((arg as { fd: unknown }).fd)}`;
  if (s === null) return null;
  return s.length > TARGET_CAP ? s.slice(0, TARGET_CAP) : s;
}

// Timed async calls in flight (each `scanGlob` step counts as one).
let inFlight = 0;

function observe(
  layer: FsWaitLayer,
  op: string,
  ms: number,
  target: string | null,
  concurrent: number,
): void {
  if (ms < FS_WAIT_FLOOR_MS || dispatching || handlers.length === 0) return;
  dispatching = true;
  try {
    const call: SlowFsCall = {
      layer,
      op,
      ms,
      target,
      at: Date.now(),
      concurrent,
    };
    for (const h of handlers) h(call);
  } finally {
    dispatching = false;
  }
}

/** How an awaited file call is awaited (identity until one is installed). */
type FsAwait = <T>(pending: Promise<T>) => Promise<T>;
let fsAwait: FsAwait = (pending) => pending;

/**
 * Install how every awaited file call (the promise calls, each `scanGlob`
 * step) is awaited — e.g. a gate's "hand my slots back while this is
 * pending", so a read stalled on the disk does not hold a slot others queue
 * for. One per process; the leaf cannot import the gate itself.
 */
export function installFsAwait(wrap: FsAwait): void {
  fsAwait = wrap;
}

/**
 * Called synchronously as every timed call (and every glob scan) starts, before
 * it touches the disk; a guard that throws makes the call throw, synchronously,
 * so it refuses the read rather than observing it.
 */
type FsCallGuard = (op: string, target: string | null) => void;
let fsCallGuard: FsCallGuard | null = null;

/**
 * Install (or, with `null`, remove) the one guard every file call of this
 * process passes first — e.g. barrel-import's refusal of a file read while a
 * barrel's modules evaluate (an input no evaluated record's key names). One
 * per process; the leaf cannot import the owner.
 */
export function installFsCallGuard(guard: FsCallGuard | null): void {
  fsCallGuard = guard;
}

type AnyFn = (...args: any[]) => any;

function timedAsync<F extends AnyFn>(layer: FsWaitLayer, op: string, fn: F): F {
  const timed = async (...args: Parameters<F>) => {
    const concurrent = ++inFlight;
    const t0 = performance.now();
    try {
      return await fsAwait(fn(...args) as Promise<unknown>);
    } finally {
      inFlight--;
      observe(layer, op, performance.now() - t0, targetOf(args[0]), concurrent);
    }
  };
  // The guard runs before the async body, so a refusal throws at the call.
  return ((...args: Parameters<F>) => {
    fsCallGuard?.(op, targetOf(args[0]));
    return timed(...args);
  }) as F;
}

function timedSync<F extends AnyFn>(layer: FsWaitLayer, op: string, fn: F): F {
  return ((...args: Parameters<F>) => {
    fsCallGuard?.(op, targetOf(args[0]));
    const t0 = performance.now();
    try {
      return fn(...args);
    } finally {
      observe(
        layer,
        op,
        performance.now() - t0,
        targetOf(args[0]),
        inFlight + 1,
      );
    }
  }) as F;
}

const P = TIMED_FS_CALLS.promises;
const S = TIMED_FS_CALLS.sync;

export const readFile: typeof fsp.readFile = timedAsync(
  P.readFile,
  "readFile",
  fsp.readFile,
);
export const readdir: typeof fsp.readdir = timedAsync(
  P.readdir,
  "readdir",
  fsp.readdir,
);
export const stat: typeof fsp.stat = timedAsync(P.stat, "stat", fsp.stat);
export const lstat: typeof fsp.lstat = timedAsync(P.lstat, "lstat", fsp.lstat);
export const access: typeof fsp.access = timedAsync(
  P.access,
  "access",
  fsp.access,
);
export const realpath: typeof fsp.realpath = timedAsync(
  P.realpath,
  "realpath",
  fsp.realpath,
);
export const readlink: typeof fsp.readlink = timedAsync(
  P.readlink,
  "readlink",
  fsp.readlink,
);

/**
 * Whether `path` exists — `existsSync`'s async twin, timed as the `access` it
 * is. Only "not there" (ENOENT, ENOTDIR) is a `false`: any other failure (a
 * permission refusal, a stalled volume) throws, where `existsSync` would
 * answer `false` for it.
 */
export async function exists(path: fs.PathLike): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

export const readFileSync: typeof fs.readFileSync = timedSync(
  S.readFileSync,
  "readFileSync",
  fs.readFileSync,
);
export const readdirSync: typeof fs.readdirSync = timedSync(
  S.readdirSync,
  "readdirSync",
  fs.readdirSync,
);
export const statSync: typeof fs.statSync = timedSync(
  S.statSync,
  "statSync",
  fs.statSync,
);
export const lstatSync: typeof fs.lstatSync = timedSync(
  S.lstatSync,
  "lstatSync",
  fs.lstatSync,
);
export const accessSync: typeof fs.accessSync = timedSync(
  S.accessSync,
  "accessSync",
  fs.accessSync,
);
export const existsSync: typeof fs.existsSync = timedSync(
  S.existsSync,
  "existsSync",
  fs.existsSync,
);
export const readlinkSync: typeof fs.readlinkSync = timedSync(
  S.readlinkSync,
  "readlinkSync",
  fs.readlinkSync,
);
export const realpathSync: typeof fs.realpathSync = Object.assign(
  timedSync(S.realpathSync, "realpathSync", fs.realpathSync),
  {
    native: timedSync(
      S.realpathSync,
      "realpathSync.native",
      fs.realpathSync.native,
    ),
  },
);

/** `Glob#scan`'s options (a cwd string, or the options object). */
type GlobScanArg = Parameters<Bun.Glob["scan"]>[0];

function globTarget(pattern: string, arg: GlobScanArg): string {
  const cwd = typeof arg === "string" ? arg : (arg?.cwd ?? ".");
  const s = `${cwd}/${pattern}`;
  return s.length > TARGET_CAP ? s.slice(0, TARGET_CAP) : s;
}

/**
 * `new Bun.Glob(pattern).scan(arg)`, timed: the time spent inside the scan's
 * steps (not the caller's own work between them) is summed and, once the
 * iteration ends — done, broken out of, or thrown — handed on as ONE
 * `fs-glob` call when it reaches the floor.
 */
export async function* scanGlob(
  pattern: string,
  arg?: GlobScanArg,
): AsyncGenerator<string, void, undefined> {
  fsCallGuard?.("scanGlob", globTarget(pattern, arg));
  // eslint-disable-next-line timed-fs/no-untimed-glob-scan -- the one timed scan
  const it = new Bun.Glob(pattern).scan(arg);
  let inScan = 0;
  let concurrent = 0;
  try {
    for (;;) {
      concurrent = Math.max(concurrent, ++inFlight);
      const t0 = performance.now();
      let step: IteratorResult<string>;
      try {
        step = await fsAwait(it.next());
      } finally {
        inFlight--;
        inScan += performance.now() - t0;
      }
      if (step.done) return;
      yield step.value;
    }
  } finally {
    // Broken out of early: close the walk, as a `for await` over it would.
    await it.return?.();
    observe(
      "fs-glob",
      "scanGlob",
      inScan,
      globTarget(pattern, arg),
      concurrent,
    );
  }
}

/** `new Bun.Glob(pattern).scanSync(arg)`, timed the same way as `scanGlob`. */
export function* scanGlobSync(
  pattern: string,
  arg?: GlobScanArg,
): Generator<string, void, undefined> {
  fsCallGuard?.("scanGlobSync", globTarget(pattern, arg));
  // eslint-disable-next-line timed-fs/no-untimed-glob-scan -- the one timed scan
  const it = new Bun.Glob(pattern).scanSync(arg);
  let inScan = 0;
  try {
    for (;;) {
      const t0 = performance.now();
      let step: IteratorResult<string>;
      try {
        step = it.next();
      } finally {
        inScan += performance.now() - t0;
      }
      if (step.done) return;
      yield step.value;
    }
  } finally {
    it.return?.();
    observe(
      "fs-glob",
      "scanGlobSync",
      inScan,
      globTarget(pattern, arg),
      inFlight + 1,
    );
  }
}
