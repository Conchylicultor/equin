import type { BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";

// The whole kept history of a rotated file — the live file and every `path.N`
// beside it — read as ONE line stream, newest first, by POSITION.
//
// `readTail` answers "the last few MB"; this answers "the lines before this one",
// at any depth, so a reader can page back across a rotation instead of hitting a
// silent cliff at the live file's first line.
//
// A position must survive a rotation: the live file becomes `.1`, `.1` becomes
// `.2`, so neither a generation number nor a byte offset alone names a line for
// long. A FILE's birth time does — `rename` keeps the inode, and with it the
// birth time — and a later-born file holds later lines (a rotation only ever
// starts a fresh live file). So a line's position is `(birth time, byte offset)`,
// spelled as fixed-width text whose code-point order IS the line order: the key
// a key-range-paged live value cuts at.
//
// Node-only and async (`fs/promises`): a page read on a server's hot path must
// not freeze its event loop, and history can be hundreds of MB.

/** Birth µs (17 digits) and byte offset (13 digits), zero-padded: text order = line order. */
const BORN_WIDTH = 17;
const OFFSET_WIDTH = 13;
/** Bytes pulled per backwards read. */
const CHUNK_BYTES = 256 * 1024;
/** Generations probed past the live file: a guard against a runaway rotation chain. */
const MAX_GENERATIONS = 64;

/** One file of a rotated history: the live file is generation 0, `path.N` is N. */
export interface HistoryFile {
  generation: number;
  path: string;
  bytes: number;
  /** When this file was started. */
  bornMs: number;
  /** The birth instant in µs, fixed-width — the order key of its lines. */
  bornKey: string;
  /** The last write into it. */
  modifiedMs: number;
}

/** One line of a rotated history. */
export interface HistoryLine {
  /** Fixed-width text; a later line has a greater position (see the file comment). */
  position: string;
  /** Which file holds it right now (0 = live). Moves on a rotation; `position` does not. */
  generation: number;
  /** The line's bytes as text, without its `\n`. */
  text: string;
}

function historyPosition(bornKey: string, offset: number): string {
  return bornKey + "." + String(offset).padStart(OFFSET_WIDTH, "0");
}

function parsePosition(position: string): { bornKey: string; offset: number } {
  const m = /^(\d{17})\.(\d{13})$/.exec(position);
  if (!m) throw new Error(`[file-sink] not a history position: ${position}`);
  return { bornKey: m[1] as string, offset: Number(m[2]) };
}

/** Whether `position` is a well-formed history position (a cut from outside). */
export function isHistoryPosition(position: string): boolean {
  return /^\d{17}\.\d{13}$/.test(position);
}

function generationPath(path: string, generation: number): string {
  return generation === 0 ? path : path + "." + String(generation);
}

/**
 * The files of `path`'s history that exist, newest first: the live file, then
 * `path.1`, `path.2`, … up to the first missing one. A missing live file with
 * rotations beside it (a sink that rotated and has not written since) still
 * lists the rotations. The birth time is required: a filesystem that cannot
 * report one cannot order a history, and says so loudly.
 */
export async function statHistory(path: string): Promise<HistoryFile[]> {
  const files: HistoryFile[] = [];
  for (let generation = 0; generation <= MAX_GENERATIONS; generation++) {
    const file = generationPath(path, generation);
    let st: BigIntStats;
    try {
      st = await stat(file, { bigint: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (generation === 0) continue; // a rotated-away live file
      break;
    }
    if (!(st.birthtimeNs > 0n)) {
      throw new Error(
        `[file-sink] ${file}: the filesystem reports no birth time, so its history cannot be ordered`,
      );
    }
    files.push({
      generation,
      path: file,
      bytes: Number(st.size),
      bornMs: Number(st.birthtimeMs),
      bornKey: String(st.birthtimeNs / 1000n).padStart(BORN_WIDTH, "0"),
      modifiedMs: Number(st.mtimeMs),
    });
  }
  return files;
}

export interface HistoryRange {
  /** Only lines strictly BEFORE (older than) this position; `null` = from the newest. */
  before: string | null;
  /** Only lines at or after this position; `null` = to the oldest kept. */
  notBefore: string | null;
  limit: number;
}

/**
 * The lines of `path`'s kept history inside `range`, newest first, at most
 * `range.limit`. Reads backwards in chunks from where `before` falls, crossing
 * from a file into the next older one, and stops as soon as it has `limit`
 * lines — so a page costs what it returns, at any depth. A live file's
 * unterminated last line (an append in flight) is not a line yet and is left
 * out.
 */
export async function readHistory(
  path: string,
  range: HistoryRange,
): Promise<HistoryLine[]> {
  const before = range.before === null ? null : parsePosition(range.before);
  const files = await statHistory(path);
  const out: HistoryLine[] = [];
  for (const file of files) {
    if (out.length >= range.limit) break;
    if (before !== null && file.bornKey > before.bornKey) continue; // wholly newer
    const end =
      before !== null && file.bornKey === before.bornKey
        ? Math.min(before.offset, file.bytes)
        : file.bytes;
    const reached = await readFileBackwards(file, end, range, out);
    if (reached) break;
  }
  return out;
}

/**
 * Push `file`'s complete lines that START before byte `end` onto `out`, newest
 * first, until `range.limit` or `range.notBefore`. Returns true when the walk is
 * done (limit reached or `notBefore` passed) and no older file is needed.
 */
async function readFileBackwards(
  file: HistoryFile,
  end: number,
  range: HistoryRange,
  out: HistoryLine[],
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file.path, "r");
  } catch (err) {
    // Rotated away between the stat and the open: its lines are in an older
    // generation now, which the next page reads.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  try {
    // `loaded` holds the bytes [loadedStart, curEnd): what is left to emit,
    // ending in the "\n" of the newest line not yet emitted.
    let loadedStart = end;
    let loaded = Buffer.alloc(0);
    const loadMore = async (): Promise<void> => {
      const start = Math.max(0, loadedStart - CHUNK_BYTES);
      const chunk = Buffer.allocUnsafe(loadedStart - start);
      let read = 0;
      while (read < chunk.length) {
        const { bytesRead } = await handle.read(
          chunk,
          read,
          chunk.length - read,
          start + read,
        );
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      if (read !== chunk.length)
        throw new Error(`[file-sink] ${file.path} shrank while it was read`);
      loaded = Buffer.concat([chunk, loaded]);
      loadedStart = start;
    };

    let curEnd = end;
    if (end === file.bytes) {
      // The live file's tail after its last "\n" is an append in flight, not a
      // line: the region to read ends just after that "\n".
      for (;;) {
        const nl = loaded.lastIndexOf(0x0a);
        if (nl !== -1) {
          curEnd = loadedStart + nl + 1;
          loaded = loaded.subarray(0, nl + 1);
          break;
        }
        if (loadedStart === 0) return false; // not one whole line
        await loadMore();
      }
    }

    while (curEnd > 0) {
      // The newest line left is [lineStart, curEnd - 1); find its start: the
      // "\n" before its own terminator, or the file's first byte.
      let lineStart: number;
      for (;;) {
        const from = curEnd - 2 - loadedStart;
        const nl = from >= 0 ? loaded.lastIndexOf(0x0a, from) : -1;
        if (nl !== -1) {
          lineStart = loadedStart + nl + 1;
          break;
        }
        if (loadedStart === 0) {
          lineStart = 0;
          break;
        }
        await loadMore();
      }
      const position = historyPosition(file.bornKey, lineStart);
      if (range.notBefore !== null && position < range.notBefore) return true;
      const text = loaded.toString(
        "utf8",
        lineStart - loadedStart,
        curEnd - 1 - loadedStart,
      );
      if (text !== "")
        out.push({ position, generation: file.generation, text });
      if (out.length >= range.limit) return true;
      curEnd = lineStart;
      loaded = loaded.subarray(0, lineStart - loadedStart);
    }
    return false;
  } finally {
    await handle.close();
  }
}

/**
 * The cut just after the newest line written at or before `atMs` — pass it as
 * `readHistory`'s `before` to read from that line back — by the time `timeOf`
 * reads off a line (`null` when a line carries none): the newest file whose
 * first line is not later, then a binary search of its bytes. `null` when every
 * kept line is newer (or none carries a time). Lines are taken to be written in
 * time order, as an append-only log is.
 */
export async function historyCutAt(
  path: string,
  atMs: number,
  timeOf: (line: string) => number | null,
): Promise<string | null> {
  const files = await statHistory(path);
  // Newest first: the first file whose first line is at or before `atMs`.
  for (const file of files) {
    const handle = await open(file.path, "r");
    try {
      const firstLine = await lineAt(handle, 0, file.bytes);
      const firstT = firstLine === null ? null : timeOf(firstLine.text);
      if (firstT === null || firstT > atMs) continue;
      // Binary search the line starts in [0, size) for the last line with t ≤ atMs.
      let lo = 0; // a line start known to be ≤ atMs
      let hi = file.bytes; // a byte bound past which every line is > atMs
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const line = await lineAt(handle, mid, file.bytes);
        if (line === null || line.start >= hi) {
          hi = mid;
          continue;
        }
        const t = timeOf(line.text);
        if (t !== null && t <= atMs) lo = line.start;
        else hi = mid;
      }
      const last = await lineAt(handle, lo, file.bytes);
      const cut =
        last === null
          ? lo
          : last.start + Buffer.byteLength(last.text, "utf8") + 1;
      return historyPosition(file.bornKey, cut);
    } finally {
      await handle.close();
    }
  }
  return null;
}

/** The first whole line starting at or after `from` (a line start at 0 counts). */
async function lineAt(
  handle: Awaited<ReturnType<typeof open>>,
  from: number,
  size: number,
): Promise<{ start: number; text: string } | null> {
  let pos = from;
  let start = from === 0 ? 0 : -1;
  let acc = Buffer.alloc(0);
  while (pos < size) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - pos));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, pos);
    if (bytesRead === 0) break;
    let view = chunk.subarray(0, bytesRead);
    if (start === -1) {
      // Skip to just after the previous line's "\n" (the probe landed mid-line).
      const prev = from > 0 ? await byteAt(handle, from - 1) : 0x0a;
      if (prev === 0x0a) start = from;
      else {
        const nl = view.indexOf(0x0a);
        if (nl === -1) {
          pos += bytesRead;
          continue;
        }
        start = pos + nl + 1;
        view = view.subarray(nl + 1);
      }
    }
    acc = Buffer.concat([acc, view]);
    const nl = acc.indexOf(0x0a);
    if (nl !== -1) return { start, text: acc.toString("utf8", 0, nl) };
    pos += bytesRead;
  }
  return null; // no complete line from here
}

async function byteAt(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
): Promise<number> {
  const b = Buffer.allocUnsafe(1);
  await handle.read(b, 0, 1, offset);
  return b[0] as number;
}
