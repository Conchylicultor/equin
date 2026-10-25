import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

// The bounded READ counterpart of `append()`. Lifted from
// log-channels/server/internal/persist.ts's `readTail` (a positioned
// openSync/fstatSync/readSync of the last N bytes, dropping the leading partial
// line when the read didn't start at offset 0), generalized off that plugin's
// `{t,stream,line}` envelope so any sink — or any frozen legacy file with no sink
// at all — can be read without materializing a ≤128 MB file whole into memory.
//
// Node-only, and deliberately dependency-free beyond `node:fs`: no zod, no db,
// no jobs. That is the property that keeps this plugin CLI-importable and safe to
// host in `core/`. Schema validation is the CALLER's job.

// Default byte budget pulled off disk. Matches persist.ts's READ_TAIL_BYTES
// exactly, so persist.ts can later collapse onto this reader with zero semantic
// change.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface TailOptions {
  /** Byte budget pulled off disk. Default 8 MB. */
  maxBytes?: number;
  /** Cap on returned lines (newest kept). Default unbounded within the budget. */
  maxLines?: number;
  /** Walk `path.1`, `path.2`, … until the budget is met. Default false. */
  includeRotated?: boolean;
}

/**
 * A tail read.
 *
 * `missing` is a DISTINCT case, not `[]`: collapsing a missing file into an empty
 * array makes "no file has ever been written here" indistinguishable from "the
 * file exists and holds no lines" — the repo's absorbed-failure rule. A caller
 * that genuinely wants empty writes one visible line (`if (r.kind === "missing")
 * return []`).
 *
 * `truncated` is true whenever the budget clipped history, so a partial window can
 * never be presented as a complete one.
 */
export type TailResult =
  | { kind: "missing" }
  | { kind: "read"; lines: string[]; truncated: boolean; filesRead: number };

/** `TailResult` with each line tolerantly `JSON.parse`d into a `T`. */
export type JsonlTailResult<T> =
  | { kind: "missing" }
  | { kind: "read"; records: T[]; truncated: boolean; filesRead: number };

function rotationPath(path: string, n: number): string {
  return path + "." + String(n);
}

interface FileChunk {
  /** Decoded text of the bytes actually read. */
  text: string;
  /** True when the read did NOT start at offset 0 (so the first line is partial). */
  clipped: boolean;
}

/**
 * Positioned read of at most the LAST `budget` bytes of `file`.
 *
 * Returns `null` for a missing file; every other fs error rethrows (a permission
 * error or a bad fd is a real bug, not an empty file).
 */
function readLastBytes(file: string, budget: number): FileChunk | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - budget);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buf, offset, length - offset, start + offset);
      if (read === 0) break;
      offset += read;
    }
    return { text: buf.toString("utf8", 0, offset), clipped: start > 0 };
  } finally {
    closeSync(fd);
  }
}

/** {@link readLastBytes} without blocking the event loop. */
async function readLastBytesAsync(
  file: string,
  budget: number,
): Promise<FileChunk | null> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - budget);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buf,
        offset,
        length - offset,
        start + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { text: buf.toString("utf8", 0, offset), clipped: start > 0 };
  } finally {
    await handle.close();
  }
}

function splitLines(text: string): string[] {
  return text.split("\n").filter((l) => l !== "");
}

/**
 * Read the tail of `path` (and, with `includeRotated`, its rotated history) as raw
 * lines, oldest-first.
 *
 * ### Rotation stitching
 *
 * With `includeRotated`, the walk goes live → `.1` → `.2` … and stops at the first
 * absent slot or once the byte budget is exhausted. The chunks are concatenated
 * OLDEST-FIRST so line order stays chronological, and the leading partial line is
 * dropped only for the OLDEST file actually opened (the only one whose read can
 * have started mid-line).
 *
 * This is safe because of an invariant of the writer: **a line is never split
 * across a rotation.** `append()` writes one whole `line + "\n"` per call, and
 * rotation happens BETWEEN appends (the size gate runs before the write, and the
 * post-rotation line goes wholly into the fresh live file). So concatenating the
 * files reproduces the original line stream exactly — no line needs rejoining
 * across a file boundary.
 */
export function readTail(path: string, opts: TailOptions = {}): TailResult {
  const budget = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const includeRotated = opts.includeRotated ?? false;

  // Newest-first while walking; reversed to oldest-first before joining.
  const chunks: FileChunk[] = [];
  let remaining = budget;

  const live = readLastBytes(path, remaining);
  if (live === null) return { kind: "missing" };
  chunks.push(live);
  remaining -= Buffer.byteLength(live.text, "utf8");

  // True when a further rotation existed on disk but the budget stopped us.
  let moreHistoryExists = false;

  if (includeRotated) {
    for (let n = 1; ; n++) {
      if (remaining <= 0) {
        // Budget spent. If another rotation slot exists, we are dropping history.
        moreHistoryExists = readLastBytes(rotationPath(path, n), 1) !== null;
        break;
      }
      const chunk = readLastBytes(rotationPath(path, n), remaining);
      if (chunk === null) break; // no `.n` — history ends here
      chunks.push(chunk);
      remaining -= Buffer.byteLength(chunk.text, "utf8");
    }
  }

  return assembleTail(chunks, moreHistoryExists, opts);
}

/**
 * {@link readTail} without blocking the event loop — the same walk, budget and
 * stitching over `node:fs/promises`, for a reader inside a shared async cycle
 * (a live-resource loader) where a synchronous read freezes everything else.
 */
export async function readTailAsync(
  path: string,
  opts: TailOptions = {},
): Promise<TailResult> {
  const budget = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const includeRotated = opts.includeRotated ?? false;

  const chunks: FileChunk[] = [];
  let remaining = budget;

  const live = await readLastBytesAsync(path, remaining);
  if (live === null) return { kind: "missing" };
  chunks.push(live);
  remaining -= Buffer.byteLength(live.text, "utf8");

  let moreHistoryExists = false;

  if (includeRotated) {
    for (let n = 1; ; n++) {
      if (remaining <= 0) {
        moreHistoryExists =
          (await readLastBytesAsync(rotationPath(path, n), 1)) !== null;
        break;
      }
      const chunk = await readLastBytesAsync(rotationPath(path, n), remaining);
      if (chunk === null) break;
      chunks.push(chunk);
      remaining -= Buffer.byteLength(chunk.text, "utf8");
    }
  }

  return assembleTail(chunks, moreHistoryExists, opts);
}

/** The newest-first chunks of a tail walk, stitched oldest-first into lines. */
function assembleTail(
  chunks: FileChunk[],
  moreHistoryExists: boolean,
  opts: TailOptions,
): TailResult {
  chunks.reverse(); // oldest-first
  // Only the OLDEST opened file can have a partial leading line: every newer chunk
  // was read from offset 0 (the budget is spent walking backwards, so a chunk is
  // only clipped when it is where the budget ran out).
  let clippedHistory = false;
  let first = true;
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (first) {
      first = false;
      if (chunk.clipped) {
        clippedHistory = true;
        const nl = chunk.text.indexOf("\n");
        parts.push(nl === -1 ? "" : chunk.text.slice(nl + 1));
        continue;
      }
    }
    parts.push(chunk.text);
  }

  let lines = splitLines(parts.join(""));

  let droppedByLineCap = false;
  if (opts.maxLines !== undefined && lines.length > opts.maxLines) {
    lines = lines.slice(-opts.maxLines); // keep the NEWEST
    droppedByLineCap = true;
  }

  return {
    kind: "read",
    lines,
    truncated: clippedHistory || moreHistoryExists || droppedByLineCap,
    filesRead: chunks.length,
  };
}

/**
 * `readTail` with each line `JSON.parse`d into a `T`.
 *
 * A `SyntaxError` on a line is SKIPPED — that is exactly the torn-tail case the
 * bounded read can produce (a half-flushed append, or the truncated leading line
 * of a clipped read). Any OTHER error rethrows: a reviver throwing, a stack
 * overflow, an out-of-memory — those are real bugs and must not be silently
 * turned into a shorter list.
 *
 * No schema validation here on purpose: this plugin imports only `node:fs` /
 * `node:path`. `T` is an unchecked assertion; a caller that needs a guarantee
 * validates (e.g. `safeParse`) on top.
 */
export function readJsonlTail<T>(path: string, opts: TailOptions = {}): JsonlTailResult<T> {
  return parseJsonlTail<T>(readTail(path, opts));
}

/** {@link readJsonlTail} without blocking the event loop (see {@link readTailAsync}). */
export async function readJsonlTailAsync<T>(
  path: string,
  opts: TailOptions = {},
): Promise<JsonlTailResult<T>> {
  return parseJsonlTail<T>(await readTailAsync(path, opts));
}

function parseJsonlTail<T>(result: TailResult): JsonlTailResult<T> {
  if (result.kind === "missing") return { kind: "missing" };

  const records: T[] = [];
  for (const line of result.lines) {
    let parsed: T;
    try {
      parsed = JSON.parse(line) as T;
    } catch (err) {
      if (err instanceof SyntaxError) continue; // torn/partial line
      throw err;
    }
    records.push(parsed);
  }
  return {
    kind: "read",
    records,
    truncated: result.truncated,
    filesRead: result.filesRead,
  };
}
