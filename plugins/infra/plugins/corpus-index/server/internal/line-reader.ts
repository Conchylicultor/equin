import type { LineFold } from "../../core";
import type { Checkpoint, CheckpointStore } from "./checkpoints";

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
// replaced by rename) folds the file again from its first byte.
//
// A state no read holds — a process's first read of a file, or one evicted —
// continues from the file's on-disk checkpoint (`checkpoints.ts`), validated
// the same way: a backend restart costs the bytes appended since the
// checkpoint, not the file. A checkpoint is written once a read has folded
// {@link CHECKPOINT_MIN_BYTES} past the last one — and at least
// {@link CHECKPOINT_RATIO}× the last checkpoint's own size, so writing them
// costs at most 1/{@link CHECKPOINT_RATIO} of the bytes folded — so what a
// new process re-folds is bounded by that window.

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
/** Fold at least this many bytes past a file's last checkpoint before writing the next. */
const CHECKPOINT_MIN_BYTES = 1024 * 1024;
/** …and at least this many times the last checkpoint's size. */
const CHECKPOINT_RATIO = 8;
const decoder = new TextDecoder();

/** Where a fold stands in its file: the part a held state and a checkpoint share. */
interface Position {
  ino: number;
  /** Byte offset of the first line not folded yet — always a line start. */
  offset: number;
  /** The (up to) {@link TAIL_BYTES} bytes ending at `offset`. */
  tail: Uint8Array;
}

interface Held extends Position {
  state: unknown;
  /** The offset of the file's last checkpoint (0 when it has none). */
  savedAt: number;
  /** That checkpoint's size in bytes. */
  savedBytes: number;
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
  /** Where fold states outlive the process (`checkpoints.ts`). */
  checkpoints: CheckpointStore;
}

export interface LineReader<TPartial> {
  /** `path`'s partial with every complete line up to `file.size` folded. */
  read(path: string, file: FileStamp): Promise<TPartial>;
  /** `path` left the index: drop its held state and its checkpoint. */
  forget(path: string): Promise<void>;
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
    held: Position,
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

  /** `path`'s checkpoint as a held state, when it still describes the file. */
  async function restore(
    path: string,
    file: FileStamp,
  ): Promise<Held | undefined> {
    const stored = await deps.checkpoints.load(path);
    if (stored.kind === "none") return undefined;
    const { checkpoint } = stored;
    if (!(await continues(path, checkpoint, file))) return undefined;
    return {
      ino: checkpoint.ino,
      offset: checkpoint.offset,
      tail: checkpoint.tail,
      state: fold.load(checkpoint.state),
      savedAt: checkpoint.offset,
      savedBytes: stored.bytes,
    };
  }

  /** Checkpoint `held` once it has folded far enough past its last one. */
  async function checkpoint(path: string, held: Held): Promise<void> {
    const { writer } = deps.checkpoints;
    if (writer === null) return;
    const due = Math.max(
      CHECKPOINT_MIN_BYTES,
      CHECKPOINT_RATIO * held.savedBytes,
    );
    if (held.offset - held.savedAt < due) return;
    const saved: Checkpoint = {
      ino: held.ino,
      offset: held.offset,
      tail: held.tail,
      state: fold.save(held.state),
    };
    held.savedBytes = await writer.save(path, saved);
    held.savedAt = held.offset;
  }

  async function read(path: string, file: FileStamp): Promise<TPartial> {
    let held = states.get(path);
    // Out while it is advanced: a read that throws midway leaves no
    // half-folded state behind.
    states.delete(path);
    if (held !== undefined && !(await continues(path, held, file))) {
      held = undefined;
    }
    held ??= (await restore(path, file)) ?? {
      ino: file.ino,
      offset: 0,
      tail: new Uint8Array(0),
      state: fold.start(path),
      savedAt: 0,
      savedBytes: 0,
    };
    await advance(path, held, file.size);
    await checkpoint(path, held);
    states.set(path, held);
    while (states.size > deps.maxHeld) {
      const oldest = states.keys().next();
      if (oldest.done) break;
      states.delete(oldest.value);
    }
    return fold.partial(held.state);
  }

  async function forget(path: string): Promise<void> {
    states.delete(path);
    await deps.checkpoints.writer?.remove(path);
  }

  return { read, forget, held: () => states.size };
}
