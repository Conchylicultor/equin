import {
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
// Relative sibling import, not the `@plugins/infra/plugins/file-sink/core` alias:
// this file now lives INSIDE that barrel's plugin, so the alias form would cycle
// back through the barrel that re-exports it.
import type { FileSink, FileSinkSpec, RotateBound } from "./types";
import type { JsonlTailResult, TailOptions, TailResult } from "./read";
import { readJsonlTail, readTail } from "./read";

// The bounded-append / rotation primitive, extracted from
// log-channels/server/internal/persist.ts. Node-only: `node:fs` + `node:path`,
// NO `db`, NO `jobs` — so a short-lived CLI process (no server, no DB) can import
// it and still get a size-bounded file. The caller supplies an ABSOLUTE path; the
// JSON envelope (or any other line encoding) is the caller's concern — `append`
// and `appendAll` are generic and write `line + "\n"` verbatim.

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
function rotationPath(path: string, n: number): string {
  return path + "." + String(n);
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function renameIfExists(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// Shift the rotation window down and move the live file into slot .1. Net effect:
// at most `keep` rotated files survive; the next appendFileSync recreates a fresh
// live file. renameSync is atomic within a dir; ENOENT is tolerated on every slot
// (a rotation slot may not exist yet), but any other error rethrows.
function rotateFile(path: string, keep: number): void {
  // Drop the oldest rotation first, then shift .(K-1)→.K … .1→.2, then live→.1.
  unlinkIfExists(rotationPath(path, keep));
  for (let i = keep - 1; i >= 1; i--) {
    renameIfExists(rotationPath(path, i), rotationPath(path, i + 1));
  }
  renameIfExists(path, rotationPath(path, 1));
}

// Live-file path → its current byte size (seeded once from disk on first miss).
// We gate on this in-memory per-file counter rather than a `statSync` on every
// append — a stat per line would double the syscall cost on this synchronous hot
// path. Process-global so repeated `append`s to the same path stay cheap.
const fileBytes = new Map<string, number>();

// The live file's current size: the in-memory counter, seeded from disk the first
// time this process touches the path. A file that isn't there yet is 0 bytes;
// anything other than ENOENT is a real error and rethrows.
function currentSize(path: string): number {
  const known = fileBytes.get(path);
  if (known !== undefined) return known;
  try {
    return statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return 0;
  }
}

// Append `payload`, creating the parent dir only if it turns out to be missing.
// For a file opened with flag "a", ENOENT means EXACTLY one thing: a missing path
// component. So this is behaviourally identical to the unconditional `mkdirSync`
// that used to run before every write — self-healing included, if a live
// backend's logs dir is deleted under it — minus the mkdir syscall in the steady
// state, which is every write after the first. Deliberately NOT memoized with a
// Set of already-ensured dirs: that caches a belief about the world which a
// worktree teardown can falsify. A second ENOENT rethrows — loud.
function writeAppend(path: string, payload: string): void {
  try {
    appendFileSync(path, payload);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, payload);
  }
}

// THE one write path: `append(line)` is `appendLines(path, [line], …)` and
// `appendAll(lines)` is `appendLines(path, lines, …)`. One implementation, one
// size gate — two copies of the gate is exactly how the "a line is never split
// across a rotation" invariant would drift between the singular and the batch
// form.
//
// The gate runs per ROTATION GROUP — not per batch, not per line. Lines
// accumulate until the next one would cross `maxBytes`; that group goes out as
// ONE `appendFileSync`, and only then does the file rotate. Byte-for-byte what
// `for (const l of lines) append(l)` produces, with the writes coalesced. Four
// properties follow, and readers depend on them:
//
//   - Every `appendFileSync` payload is a whole number of "\n"-terminated lines,
//     and a rotation only ever happens BETWEEN two of them. That is precisely
//     what `readTail({ includeRotated: true })`'s stitching relies on: a line is
//     never split across a rotation, batch or no batch.
//   - A batch larger than `maxBytes` performs several rotations inside the one
//     call and `keep` stays a hard cap — identical to looping `append` today.
//   - `fileBytes` is updated immediately after each successful write and zeroed
//     immediately after each rotation, so a mid-batch ENOSPC leaves the counter
//     describing exactly what is on disk.
//   - The `size + groupBytes > 0` half of the gate is a DELIBERATE behaviour
//     change from the old per-line gate: a single line larger than `maxBytes`
//     going into an empty (or absent) live file is written whole, without first
//     burning a rotation slot on a no-op rename chain that would evict real
//     history to make room for nothing. Reachable only in that degenerate case —
//     the line is oversized either way, so the choice is whether to also lose a
//     rotation.
function appendLines(
  path: string,
  lines: readonly string[],
  maxBytes: number,
  keep: number,
): void {
  // No lines ⇒ no write, no mkdir, no file. A caller holding an empty array must
  // not bring the file into existence as a side effect of asking for nothing.
  if (lines.length === 0) return;

  let size = currentSize(path);
  let group: string[] = [];
  let groupBytes = 0;

  // One appendFileSync per rotation group.
  const flush = (): void => {
    if (group.length === 0) return;
    writeAppend(path, group.join("\n") + "\n");
    size += groupBytes;
    fileBytes.set(path, size);
    group = [];
    groupBytes = 0;
  };

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // + the "\n"
    if (size + groupBytes + lineBytes > maxBytes && size + groupBytes > 0) {
      // Write what fits, THEN rotate: the group already in hand belongs to the
      // pre-rotation file, and this line starts the fresh one.
      flush();
      rotateFile(path, keep);
      size = 0;
      fileBytes.set(path, 0);
    }
    group.push(line);
    groupBytes += lineBytes;
  }
  flush();
}

function makeSink(
  id: string,
  description: string,
  pathSpec: string | (() => string),
  maxBytes: number,
  keep: number,
): FileSink {
  const bound: RotateBound = { kind: "rotate", maxBytes, keep };
  // A lazy path is resolved once, on first use, and kept (see FileSinkSpec.path).
  let resolved: string | null = typeof pathSpec === "string" ? pathSpec : null;
  const pathOf = (): string => {
    if (resolved === null && typeof pathSpec === "function")
      resolved = pathSpec();
    return resolved as string;
  };
  return {
    id,
    description,
    get path(): string {
      return pathOf();
    },
    bound,
    append(line: string): void {
      appendLines(pathOf(), [line], maxBytes, keep);
    },
    appendAll(lines: readonly string[]): void {
      appendLines(pathOf(), lines, maxBytes, keep);
    },
    // The read budget is deliberately NOT derived from `maxBytes`: a default sink
    // is 128 MB × 3, so `bound`-derived defaults would mean a 512 MB read. The
    // reader carries its own 8 MB default; a caller that wants more says so.
    readTail(opts?: TailOptions): TailResult {
      return readTail(pathOf(), opts);
    },
    readJsonlTail<T>(opts?: TailOptions): JsonlTailResult<T> {
      return readJsonlTail<T>(pathOf(), opts);
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
export function openDynamicSink(dir: string, name: string): FileSink {
  const path = join(dir, sanitizeChannel(name) + ".jsonl");
  return makeSink(
    name,
    "A dynamic sink of an open-ended family",
    path,
    DEFAULT_MAX_BYTES,
    DEFAULT_KEEP,
  );
}
