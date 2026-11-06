import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { open, type FileHandle } from "node:fs/promises";
import { AgentEventSchema, type AgentEvent } from "../../core";
import type { ReadPosition } from "../../server/internal/read-position";

// Reading an agent's events.jsonl incrementally, across its rotations.
//
// The agent writes through a `defineFileSink`, which rotates the live file at
// 128 MB to `<path>.1` (shifting `.1` → `.2`, …, dropping the oldest of
// `keep`). A reader remembers where it stopped as (inode, byte offset) of the
// file it was reading. On the next read:
//   - the live file has that inode → read on from the offset;
//   - it does not → the file rotated: find the generation that now has that
//     inode, read it on from the offset, then every newer generation and the
//     live file whole;
//   - no file has it (more rotations than `keep` happened in between, or the
//     backend has no position yet), or the file that has it is shorter than
//     the offset (an inode reused by a new file) → read every generation and
//     the live file whole, oldest first.
// The seq cursor does the rest: lines at or below it are skipped (the reducer),
// and a jump past it is reported as a gap there. Only complete lines are taken
// — a line the agent is mid-way through appending is read next time.

/** How many rotated generations the agent's sink keeps (`defineFileSink`'s default). */
const SINK_KEEP = 3;

interface OpenFile {
  handle: FileHandle;
  ino: number;
  size: number;
}

async function openIfExists(path: AppPath): Promise<OpenFile | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const st = await handle.stat();
    return { handle, ino: st.ino, size: st.size };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/** The complete lines of `file` from `offset`, and the offset after the last one. */
async function readLinesFrom(
  file: OpenFile,
  offset: number,
): Promise<{ lines: string[]; end: number }> {
  const length = file.size - offset;
  if (length <= 0) return { lines: [], end: offset };
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead: n } = await file.handle.read(
      buf,
      read,
      length - read,
      offset + read,
    );
    if (n === 0) break;
    read += n;
  }
  const lastNl = buf.lastIndexOf(0x0a, read - 1);
  if (lastNl < 0) return { lines: [], end: offset };
  const text = buf.subarray(0, lastNl).toString("utf8");
  return {
    lines: text.split("\n").filter((l) => l.length > 0),
    end: offset + lastNl + 1,
  };
}

function parseLine(path: string, line: string): AgentEvent {
  try {
    return AgentEventSchema.parse(JSON.parse(line));
  } catch (err) {
    throw new Error(
      `${path}: unreadable event line (${err instanceof Error ? err.message : String(err)}): ${line.slice(0, 200)}`,
    );
  }
}

/**
 * Every complete event line of the file family at `path` after `position`
 * (null: from the oldest generation), and where the read stopped.
 */
export async function readAgentEvents(
  path: AppPath,
  position: ReadPosition | null,
): Promise<{ events: AgentEvent[]; position: ReadPosition | null }> {
  // Oldest first: <path>.keep … <path>.1, then the live file.
  const paths: AppPath[] = [
    ...Array.from({ length: SINK_KEEP }, (_, i) =>
      asAppPath(`${path}.${SINK_KEEP - i}`),
    ),
    path,
  ];
  // One at a time, so a failed open leaves only the ones before it to close.
  const files: (OpenFile | null)[] = [];
  try {
    for (const p of paths) files.push(await openIfExists(p));
    const live = files.at(-1) ?? null;
    let start = 0;
    let startOffset = 0;
    if (position) {
      const at = files.findIndex(
        (f) => f?.ino === position.ino && f.size >= position.offset,
      );
      if (at >= 0) {
        start = at;
        startOffset = position.offset;
      }
    }
    const events: AgentEvent[] = [];
    let next: ReadPosition | null = position;
    for (let i = start; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      const { lines, end } = await readLinesFrom(
        file,
        i === start ? startOffset : 0,
      );
      for (const line of lines) events.push(parseLine(paths[i]!, line));
      if (file === live) next = { ino: file.ino, offset: end };
    }
    return { events, position: live ? next : null };
  } finally {
    for (const f of files) if (f) await f.handle.close();
  }
}

/**
 * The lines past `cursorSeq`, read on from `from` — the position stored with
 * that cursor, or this process's own — when it holds them. A position the
 * cursor was read up to starts at the line after it; one whose first line is
 * further on named other bytes (the file replaced, an inode reused), so the
 * whole family is read instead, as with no position at all, and a real gap is
 * left for the reducer to report.
 */
export async function readEventsAfter(
  path: AppPath,
  cursorSeq: number,
  from: ReadPosition | null,
): Promise<{ events: AgentEvent[]; position: ReadPosition | null }> {
  const read = await readAgentEvents(path, from);
  const first = read.events[0];
  if (from === null || !first || first.seq <= cursorSeq + 1) return read;
  return readAgentEvents(path, null);
}
