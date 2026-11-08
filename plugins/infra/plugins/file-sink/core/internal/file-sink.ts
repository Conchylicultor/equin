import {
  type AppPath,
  appPathParent,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { appendFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { appendFile, mkdir, rename, unlink } from "node:fs/promises";
import { createKeyedCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { stat, statSync } from "@plugins/packages/plugins/timed-fs/core";
import { basename, dirname } from "node:path";
// Relative sibling import, not the `@plugins/infra/plugins/file-sink/core` alias:
// this file now lives INSIDE that barrel's plugin, so the alias form would cycle
// back through the barrel that re-exports it.
import type { FileSink, FileSinkSpec, RotateBound } from "./types";
import type { JsonlTailResult, TailOptions, TailResult } from "./read";
import { readJsonlTailSync, readTailSync } from "./read";

// The bounded-append / rotation primitive, extracted from
// log-channels/server/internal/persist.ts. Node-only: `node:fs` + `node:path`,
// NO `db`, NO `jobs` — so a short-lived CLI process (no server, no DB) can import
// it and still get a size-bounded file. The caller supplies an ABSOLUTE path; the
// JSON envelope (or any other line encoding) is the caller's concern — `append`
// and `appendAll` are generic and write `line + "\n"` verbatim. `append` /
// `appendAll` are asynchronous (queued per path); `appendSync` / `appendAllSync`
// are for a process that may block — never a backend.

// Defaults match persist.ts's historical constants: the live-state.jsonl channel
// grew to ~4 GB with zero size management, so every sink caps at 128 MB and keeps
// 3 rotated files.
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_KEEP = 3;

// Replace any char outside [A-Za-z0-9_-] with "_" so an open-ended, externally
// supplied name (a browser `clientLog` channel id) can never escape its dir
// (path-traversal guard). Security-load-bearing. `defineFileSink` does NOT
// sanitize — its `path` is caller-owned and trusted; only `openDynamicSink`, the
// one open-ended family, sanitizes an untrusted name.
export function sanitizeChannel(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

// Rotated files are named `path.N` — the numeric suffix is appended AFTER the
// full live path (so a `foo.jsonl` live file rotates to `foo.jsonl.1`, and a
// `endsWith(".jsonl")` listing filter naturally excludes the rotations).
function rotationPath(path: AppPath, n: number): AppPath {
  return joinAppPath(appPathParent(path), `${basename(path)}.${n}`);
}

function unlinkIfExistsSync(path: AppPath): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function renameIfExistsSync(from: AppPath, to: AppPath): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// Shift the rotation window down and move the live file into slot .1. Net effect:
// at most `keep` rotated files survive; the next append recreates a fresh live
// file. A rename is atomic within a dir; ENOENT is tolerated on every slot (a
// rotation slot may not exist yet), but any other error rethrows.
function rotateFileSync(path: AppPath, keep: number): void {
  // Drop the oldest rotation first, then shift .(K-1)→.K … .1→.2, then live→.1.
  unlinkIfExistsSync(rotationPath(path, keep));
  for (let i = keep - 1; i >= 1; i--) {
    renameIfExistsSync(rotationPath(path, i), rotationPath(path, i + 1));
  }
  renameIfExistsSync(path, rotationPath(path, 1));
}

async function rotateFile(path: AppPath, keep: number): Promise<void> {
  await ignoreEnoent(unlink(rotationPath(path, keep)));
  for (let i = keep - 1; i >= 1; i--) {
    await ignoreEnoent(
      rename(rotationPath(path, i), rotationPath(path, i + 1)),
    );
  }
  await ignoreEnoent(rename(path, rotationPath(path, 1)));
}

async function ignoreEnoent(op: Promise<void>): Promise<void> {
  try {
    await op;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// Live-file path → its current byte size (seeded once from disk on first miss).
// We gate on this in-memory per-file counter rather than a stat on every append
// — a stat per line would double the syscall cost of the hot append path.
// Process-global so repeated appends to the same path stay cheap.
const fileBytes = new Map<AppPath, number>();

// The live file's current size: the in-memory counter, seeded from disk the first
// time this process touches the path. A file that isn't there yet is 0 bytes;
// anything other than ENOENT is a real error and rethrows.
function currentSizeSync(path: AppPath): number {
  const known = fileBytes.get(path);
  if (known !== undefined) return known;
  try {
    return statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return 0;
  }
}

async function currentSize(path: AppPath): Promise<number> {
  const known = fileBytes.get(path);
  if (known !== undefined) return known;
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return 0;
  }
}

// Append `payload`, creating the parent dir only if it turns out to be missing.
// For a file opened with flag "a", ENOENT means EXACTLY one thing: a missing path
// component. So this is behaviourally identical to an unconditional mkdir before
// every write — self-healing included, if a live backend's logs dir is deleted
// under it — minus the mkdir syscall in the steady state, which is every write
// after the first. Deliberately NOT memoized with a Set of already-ensured dirs:
// that caches a belief about the world which a worktree teardown can falsify. A
// second ENOENT rethrows — loud.
function writeAppendSync(path: AppPath, payload: string): void {
  try {
    appendFileSync(path, payload);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(asAppPath(dirname(path)), { recursive: true });
    appendFileSync(path, payload);
  }
}

async function writeAppend(path: AppPath, payload: string): Promise<void> {
  try {
    await appendFile(path, payload);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await mkdir(asAppPath(dirname(path)), { recursive: true });
    await appendFile(path, payload);
  }
}

/** One step of an append: write a whole group of lines, or rotate the file. */
type AppendStep =
  | { kind: "write"; payload: string; bytes: number; lines: number }
  | { kind: "rotate" };

// THE size gate, shared by both writers (`appendLinesSync`, `appendLines`): one
// gate — two copies of it is exactly how the "a line is never split across a
// rotation" invariant would drift between the sync and the async writer, or
// between the singular and the batch form.
//
// The gate runs per ROTATION GROUP — not per batch, not per line. Lines
// accumulate until the next one would cross `maxBytes`; that group goes out as
// ONE append, and only then does the file rotate. Byte-for-byte what
// `for (const l of lines) append(l)` produces, with the writes coalesced. Four
// properties follow, and readers depend on them:
//
//   - Every append payload is a whole number of "\n"-terminated lines, and a
//     rotation only ever happens BETWEEN two of them. That is precisely what
//     `readTail({ includeRotated: true })`'s stitching relies on: a line is
//     never split across a rotation, batch or no batch.
//   - A batch larger than `maxBytes` performs several rotations inside the one
//     call and `keep` stays a hard cap — identical to looping `append`.
//   - The writer updates `fileBytes` immediately after each successful write
//     and zeroes it immediately after each rotation, so a mid-batch ENOSPC
//     leaves the counter describing exactly what is on disk.
//   - The `size + groupBytes > 0` half of the gate is deliberate: a single line
//     larger than `maxBytes` going into an empty (or absent) live file is
//     written whole, without first burning a rotation slot on a no-op rename
//     chain that would evict real history to make room for nothing.
function planAppend(
  size: number,
  lines: readonly string[],
  maxBytes: number,
): AppendStep[] {
  const steps: AppendStep[] = [];
  let group: string[] = [];
  let groupBytes = 0;
  const flush = (): void => {
    if (group.length === 0) return;
    steps.push({
      kind: "write",
      payload: group.join("\n") + "\n",
      bytes: groupBytes,
      lines: group.length,
    });
    size += groupBytes;
    group = [];
    groupBytes = 0;
  };
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // + the "\n"
    if (size + groupBytes + lineBytes > maxBytes && size + groupBytes > 0) {
      // Write what fits, THEN rotate: the group already in hand belongs to the
      // pre-rotation file, and this line starts the fresh one.
      flush();
      steps.push({ kind: "rotate" });
      size = 0;
    }
    group.push(line);
    groupBytes += lineBytes;
  }
  flush();
  return steps;
}

// The synchronous writer: for a process that may not wait — a CLI line written
// right before it exits, an `exit` handler. Never on a backend's thread
// (`blocking-fs/no-sync-fs`): a busy disk turns one append into seconds of
// frozen event loop (3.2 s measured on main, a health-monitor tick's log line).
function appendLinesSync(
  path: AppPath,
  lines: readonly string[],
  maxBytes: number,
  keep: number,
): void {
  // No lines ⇒ no write, no mkdir, no file. A caller holding an empty array must
  // not bring the file into existence as a side effect of asking for nothing.
  if (lines.length === 0) return;
  let size = currentSizeSync(path);
  for (const step of planAppend(size, lines, maxBytes)) {
    if (step.kind === "write") {
      writeAppendSync(path, step.payload);
      size += step.bytes;
    } else {
      rotateFileSync(path, keep);
      size = 0;
    }
    fileBytes.set(path, size);
  }
}

// `onWrite(n)` is told, right before a write is issued, that it carries the
// next `n` lines — the queue keeps them until then (see `waiting`).
async function appendLines(
  path: AppPath,
  lines: readonly string[],
  maxBytes: number,
  keep: number,
  onWrite: (lines: number) => void,
): Promise<void> {
  if (lines.length === 0) return;
  let size = await currentSize(path);
  for (const step of planAppend(size, lines, maxBytes)) {
    if (step.kind === "write") {
      onWrite(step.lines);
      await writeAppend(path, step.payload);
      size += step.bytes;
    } else {
      await rotateFile(path, keep);
      size = 0;
    }
    fileBytes.set(path, size);
  }
}

// The asynchronous writer, one queue per live path in this process: at most one
// drain runs per path, and every line appended while it runs folds into ONE
// trailing drain, in arrival order. So appends never interleave or reorder, two
// drains can never both decide to rotate, and a burst against a slow disk costs
// two writes, not one per caller. Keyed by path, not by sink: `openDynamicSink`
// mints a fresh sink object for the same file on every call.
//
// A line stays in `waiting` (the queue's own buffer, not the coalescer's)
// until the write carrying it is issued, so a process that exits —
// `process.exit`, a fatal report, an uncaught exception — writes every line
// not yet issued synchronously from its `exit` listener
// (`flushQueuedAppendsSync`) instead of dropping it. Only a write already
// issued (with the OS) or a SIGKILL can lose a line.
const rotation = new Map<AppPath, { maxBytes: number; keep: number }>();
const waiting = new Map<AppPath, string[]>();
const drains = createKeyedCoalescer<AppPath>({
  run: (path) => {
    const queued = waiting.get(path) ?? [];
    // This drain writes the lines queued now; later ones wait for the next.
    const lines = queued.slice();
    const { maxBytes, keep } = rotation.get(path)!;
    return appendLines(path, lines, maxBytes, keep, (n) => {
      queued.splice(0, n);
      if (queued.length === 0 && waiting.get(path) === queued)
        waiting.delete(path);
    });
  },
});
/**
 * Write every queued line no write has carried yet, synchronously, in order —
 * for a process's `exit` listener, which cannot wait (file-sink's server half
 * arms one in every backend; a CLI root calls it from its own). A write already
 * issued is the OS's; this never repeats it.
 */
export function flushQueuedAppendsSync(): void {
  for (const [path, lines] of waiting) {
    waiting.delete(path);
    const { maxBytes, keep } = rotation.get(path)!;
    appendLinesSync(path, lines, maxBytes, keep);
  }
}

/**
 * Resolves once every append queued in this process so far is on disk (or has
 * failed — loudly, where it always was). For a shutdown hook: a backend stopping
 * on SIGTERM waits for its queued log lines instead of dropping them.
 */
export async function settleFileSinkWrites(): Promise<void> {
  await Promise.all([...rotation.keys()].map((path) => drains.settled(path)));
}

function makeSink(
  id: string,
  description: string,
  pathSpec: AppPath | (() => AppPath),
  maxBytes: number,
  keep: number,
): FileSink {
  const bound: RotateBound = { kind: "rotate", maxBytes, keep };
  // A lazy path is resolved once, on first use, and kept (see FileSinkSpec.path).
  let resolved: AppPath | null = typeof pathSpec === "string" ? pathSpec : null;
  const pathOf = (): AppPath => {
    if (resolved === null && typeof pathSpec === "function")
      resolved = pathSpec();
    return resolved as AppPath;
  };
  const queue = (lines: readonly string[]): Promise<void> => {
    if (lines.length === 0) return Promise.resolve();
    const path = pathOf();
    rotation.set(path, { maxBytes, keep });
    const queued = waiting.get(path);
    if (queued) for (const line of lines) queued.push(line);
    else waiting.set(path, [...lines]);
    return drains.run(path);
  };
  return {
    id,
    description,
    get path(): AppPath {
      return pathOf();
    },
    bound,
    append(line: string): Promise<void> {
      return queue([line]);
    },
    appendAll(lines: readonly string[]): Promise<void> {
      return queue(lines);
    },
    appendSync(line: string): void {
      appendLinesSync(pathOf(), [line], maxBytes, keep);
    },
    appendAllSync(lines: readonly string[]): void {
      appendLinesSync(pathOf(), lines, maxBytes, keep);
    },
    // The read budget is deliberately NOT derived from `maxBytes`: a default sink
    // is 128 MB × 3, so `bound`-derived defaults would mean a 512 MB read. The
    // reader carries its own 8 MB default; a caller that wants more says so.
    readTailSync(opts?: TailOptions): TailResult {
      return readTailSync(pathOf(), opts);
    },
    readJsonlTailSync<T>(opts?: TailOptions): JsonlTailResult<T> {
      return readJsonlTailSync<T>(pathOf(), opts);
    },
  };
}

// id → sink. Module-level ⇒ process-global; populated as a side effect of the
// declaring calls at consumer module eval (i.e. boot import phase).
const sinks = new Map<string, FileSink>();

/**
 * Declare a bounded-append file sink for `spec.path`.
 *
 * Mirrors `declareGrowthBound`'s exactly-once discipline: a sink is declared
 * EXACTLY ONCE, so ANY re-declaration of the same id throws — two owners claiming
 * one id is an authoring bug, and silently keeping one entry would hide it.
 */
export function defineFileSink(spec: FileSinkSpec): FileSink {
  const existing = sinks.get(spec.id);
  if (existing) {
    throw new Error(
      `[file-sink] sink "${spec.id}" is already defined ` +
        `(${existing.description}); a file sink is declared exactly once. ` +
        `Remove the duplicate defineFileSink.`,
    );
  }
  const sink = makeSink(
    spec.id,
    spec.description,
    spec.path,
    spec.maxBytes ?? DEFAULT_MAX_BYTES,
    spec.keep ?? DEFAULT_KEEP,
  );
  sinks.set(spec.id, sink);
  return sink;
}

/** A copy of the sink registry — callers never hold the live map. */
export function getFileSinks(): ReadonlyMap<string, FileSink> {
  return new Map(sinks);
}

/**
 * Open a sink for an OPEN-ENDED, externally supplied name (a browser `clientLog`
 * channel id). Same rotation, but the name is sanitized into `dir` and the sink
 * is NOT added to the registry — the whole family is covered by ONE declared
 * bound (registered once by the log-channels plugin), so registering each dynamic
 * id would be an unbounded registry, not a bounded one.
 */
export function openDynamicSink(dir: AppPath, name: string): FileSink {
  const path = joinAppPath(dir, sanitizeChannel(name) + ".jsonl");
  return makeSink(
    name,
    "A dynamic sink of an open-ended family",
    path,
    DEFAULT_MAX_BYTES,
    DEFAULT_KEEP,
  );
}
