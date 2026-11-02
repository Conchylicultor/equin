import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { OpLine } from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import {
  planSegments,
  SEED_BYTES,
  type FileStat,
  type IngestCursor,
  type Segment,
} from "./segments";
import { commitBatch, readCursor, type OpStoreDb } from "./store";

// The ingester's reader: turn the bytes past the cursor into committed rows.
//
// One pass = snapshot the files (open each, newest first, and read its inode
// off the fd), plan the segments, then read each segment in ~1 MB chunks and
// commit one batch per chunk. The cursor only ever lands just past a `\n`, so a
// line the writer is still appending is left for the next pass.

/** Bytes per read — one batch (and one transaction) per chunk. */
const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/** How many rotations the op-log sink keeps beside the live file (`.1` … `.3`). */
export const OP_LOG_ROTATIONS = 3;

export interface DrainOptions {
  db: OpStoreDb;
  /** The live file; rotations are `${path}.1` … `${path}.${rotations}`. */
  path: AppPath;
  rotations?: number;
  seedBytes?: number;
  chunkBytes?: number;
}

export type DrainResult =
  | { kind: "ok"; lines: number; written: number; gap: boolean }
  | { kind: "busy" }
  | { kind: "moved" };

interface OpenFile {
  fd: number;
  stat: FileStat;
}

function openIfExists(path: AppPath): OpenFile | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // The inode of what we HOLD, not of whatever the name points at by now.
  const st = fstatSync(fd, { bigint: true });
  return { fd, stat: { inode: st.ino.toString(), size: Number(st.size) } };
}

/** Parse complete lines; a line that is not an op-log record is skipped loudly. */
export function parseLines(text: string): OpLine[] {
  const out: OpLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      console.warn(
        `[op-store] skipped a malformed op-log line: ${raw.slice(0, 200)}`,
      );
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { opId?: unknown }).opId !== "string"
    ) {
      console.warn(`[op-store] skipped a non-op line: ${raw.slice(0, 200)}`);
      continue;
    }
    out.push(parsed as OpLine);
  }
  return out;
}

interface Chunk {
  lines: OpLine[];
  /** Offset just past the last complete line in this chunk. */
  end: number;
}

/**
 * Read `seg` as complete-line chunks. A chunk with no `\n` in it (a line longer
 * than `chunkBytes`) is carried into the next read rather than split.
 */
function* readSegment(
  fd: number,
  seg: Segment,
  chunkBytes: number,
): Generator<Chunk> {
  let pos = seg.from;
  let carry: Buffer = Buffer.alloc(0);
  let carryStart = pos;
  let aligning = seg.alignToLine;
  if (aligning) {
    // Start one byte early: if the byte before `from` is `\n`, `from` is already
    // a line start and only that byte is discarded.
    pos = seg.from - 1;
    carryStart = pos;
  }
  while (pos < seg.to) {
    const want = Math.min(chunkBytes, seg.to - pos);
    const buf = Buffer.allocUnsafe(want);
    const n = readSync(fd, buf, 0, want, pos);
    if (n <= 0) break;
    pos += n;
    let data =
      carry.length > 0
        ? Buffer.concat([carry, buf.subarray(0, n)])
        : buf.subarray(0, n);
    let dataStart = carryStart;
    if (aligning) {
      const nl = data.indexOf(NEWLINE);
      if (nl < 0) {
        carry = Buffer.alloc(0);
        carryStart = pos;
        continue; // still inside the clipped first line
      }
      data = data.subarray(nl + 1);
      dataStart += nl + 1;
      aligning = false;
    }
    const last = data.lastIndexOf(NEWLINE);
    if (last < 0) {
      carry = data;
      carryStart = dataStart;
      continue;
    }
    const complete = data.subarray(0, last + 1);
    carry = data.subarray(last + 1);
    carryStart = dataStart + last + 1;
    yield { lines: parseLines(complete.toString("utf8")), end: carryStart };
  }
  if (aligning) {
    // The whole segment was one clipped line: nothing complete in it.
    yield { lines: [], end: seg.to };
  }
}

/**
 * One drain pass. Reads every byte past the cursor that ends in a `\n` and
 * commits it. Never throws on a concurrent writer or rotation — those are what
 * the snapshot + inode plan absorb — and stops (without error) when another
 * process holds this DB's ingest lock or moved the cursor.
 */
export async function drainOpLog(opts: DrainOptions): Promise<DrainResult> {
  const rotations = opts.rotations ?? OP_LOG_ROTATIONS;
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const stored = await readCursor(opts.db);
  const cursor: IngestCursor | null = stored
    ? { inode: stored.inode, offset: stored.offset }
    : null;

  // Newest first: a file renamed between two opens is seen twice, never missed.
  const opened: (OpenFile | null)[] = [];
  try {
    for (let i = 0; i <= rotations; i++) {
      opened.push(
        openIfExists(i === 0 ? opts.path : asAppPath(`${opts.path}.${i}`)),
      );
    }
    const plan = planSegments(
      cursor,
      opened.map((o) => o?.stat ?? null),
      opts.seedBytes ?? SEED_BYTES,
    );

    let expected = cursor;
    let gap = plan.gap;
    let lines = 0;
    let written = 0;
    for (const seg of plan.segments) {
      const file = opened[seg.slot]!;
      let committedEnd = -1;
      let rest = seg.from;
      for (const chunk of readSegment(file.fd, seg, chunkBytes)) {
        const next = { inode: seg.inode, offset: chunk.end };
        const r = await commitBatch(opts.db, {
          expected,
          next,
          lines: chunk.lines,
          gap,
        });
        if (r.kind !== "ok") return r;
        expected = next;
        gap = false;
        lines += chunk.lines.length;
        written += r.written;
        committedEnd = chunk.end;
        rest = chunk.end;
      }
      // A segment that produced no chunk still moves the cursor onto its file
      // (a rotation to an empty live file, a seed with nothing complete yet).
      const landed = committedEnd >= 0 ? committedEnd : seg.from;
      if (
        expected === null ||
        expected.inode !== seg.inode ||
        expected.offset !== landed
      ) {
        const next = { inode: seg.inode, offset: landed };
        const r = await commitBatch(opts.db, {
          expected,
          next,
          lines: [],
          gap,
        });
        if (r.kind !== "ok") return r;
        expected = next;
        gap = false;
      }
      if (rest < seg.to && seg.slot !== 0) {
        // A rotated file is closed for writing: bytes after its last `\n` will
        // never complete. The sink never writes such a tail — say so if one
        // ever appears.
        console.warn(
          `[op-store] ${seg.to - rest} trailing bytes without a newline in a rotated op log (inode ${seg.inode}) were skipped`,
        );
      }
    }
    return { kind: "ok", lines, written, gap: plan.gap };
  } finally {
    for (const o of opened) if (o) closeSync(o.fd);
  }
}
