import type { LineFold } from "../../core";

// ─── What this is ─────────────────────────────────────────────────────────────
//
// The index's reading of a `lines` format: each file's fold state is held from
// one read to the next, so a read folds only the bytes appended since — an
// append costs its own bytes, not the file. A transcript is re-indexed on every
// line its agent writes; read whole, that was O(file) per line (~1 s for a
// 100 MB transcript), O(n²) over the conversation.
//
// A held state is continued only while the file is provably the one it read:
// the same inode, not shorter than what was folded, and the bytes just before
// the held offset unchanged. Anything else (a rewrite, a truncation, a file
// replaced by rename) folds the file again from its first byte. A state no read
// holds — a process's first read of a file, or one evicted — does the same:
// the cold read is O(file) once per process, every append after it O(append).

/** What the index knows of a file as it reads it (from the pass's own stat). */
export interface FileStamp {
  size: number;
  ino: number;
}

/** Bytes per read: the cold fold of a large file goes in steps, with a breath between. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** How many bytes before the held offset must be unchanged for the file to continue. */
const TAIL_BYTES = 64;
const NEWLINE = 0x0a;
const decoder = new TextDecoder();

interface Held {
  ino: number;
  /** Byte offset of the first line not folded yet — always a line start. */
  offset: number;
  /** The (up to) {@link TAIL_BYTES} bytes ending at `offset`. */
  tail: Uint8Array;
  state: unknown;
}

export interface LineReaderDeps {
  /**
   * How many files' fold states are held at once (least recently read
   * evicted). Bounds memory to the files being written now — the live
   * transcripts — rather than every file ever read.
   */
  maxHeld: number;
  yieldMacrotask: () => Promise<void>;
  /** The bytes `[start, end)` of `path` (fewer when the file shrank meanwhile). */
  readRange: (path: string, start: number, end: number) => Promise<Uint8Array>;
}

export interface LineReader<TPartial> {
  /** `path`'s partial with every complete line up to `file.size` folded. */
  read(path: string, file: FileStamp): Promise<TPartial>;
  /** How many file states are held (observability / tests). */
  held(): number;
}

/** The {@link LineReaderDeps.readRange} of a real file. */
export async function readFileRange(
  path: string,
  start: number,
  end: number,
): Promise<Uint8Array> {
  return await Bun.file(path).slice(start, end).bytes();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function createLineReader<TPartial>(
  fold: LineFold<unknown, TPartial>,
  deps: LineReaderDeps,
): LineReader<TPartial> {
  // Insertion order is recency: a read re-inserts its file, eviction drops
  // the first key.
  const states = new Map<string, Held>();

  /** Whether `held` still describes `path`'s first `held.offset` bytes. */
  async function continues(
    path: string,
    held: Held,
    file: FileStamp,
  ): Promise<boolean> {
    if (held.ino !== file.ino || file.size < held.offset) return false;
    if (held.tail.length === 0) return true;
    const before = await deps.readRange(
      path,
      held.offset - held.tail.length,
      held.offset,
    );
    return sameBytes(before, held.tail);
  }

  /** Fold every complete line in `[held.offset, end)` into `held`. */
  async function advance(path: string, held: Held, end: number): Promise<void> {
    // Bytes read past `held.offset` that hold no newline yet: a line longer
    // than a chunk, carried into the next read.
    let pending: Uint8Array = new Uint8Array(0);
    let pos = held.offset;
    while (pos < end) {
      const next = Math.min(pos + CHUNK_BYTES, end);
      const bytes = await deps.readRange(path, pos, next);
      let buf: Uint8Array = bytes;
      if (pending.length > 0) {
        buf = new Uint8Array(pending.length + bytes.length);
        buf.set(pending);
        buf.set(bytes, pending.length);
      }
      const nl = buf.lastIndexOf(NEWLINE);
      if (nl >= 0) {
        // A chunk boundary at a newline is a UTF-8 character boundary: the
        // newline byte never occurs inside a multi-byte sequence.
        for (const line of decoder.decode(buf.subarray(0, nl)).split("\n")) {
          if (line !== "") fold.line(held.state, line);
        }
        held.offset += nl + 1;
        held.tail = buf.slice(Math.max(0, nl + 1 - TAIL_BYTES), nl + 1);
        pending = buf.subarray(nl + 1);
      } else {
        pending = buf;
      }
      // The file shrank under the read: stop; the next read sees the size.
      if (bytes.length < next - pos) break;
      pos = next;
      if (pos < end) await deps.yieldMacrotask();
    }
  }

  async function read(path: string, file: FileStamp): Promise<TPartial> {
    let held = states.get(path);
    // Out while it is advanced: a read that throws midway leaves no
    // half-folded state behind.
    states.delete(path);
    if (held !== undefined && !(await continues(path, held, file))) {
      held = undefined;
    }
    held ??= {
      ino: file.ino,
      offset: 0,
      tail: new Uint8Array(0),
      state: fold.start(path),
    };
    await advance(path, held, file.size);
    states.set(path, held);
    while (states.size > deps.maxHeld) {
      const oldest = states.keys().next();
      if (oldest.done) break;
      states.delete(oldest.value);
    }
    return fold.partial(held.state);
  }

  return { read, held: () => states.size };
}
