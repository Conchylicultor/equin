import { open } from "node:fs/promises";
import { stat } from "@plugins/packages/plugins/timed-fs/core";
import { parseTickLine, type MonitorTick } from "../../core";

/**
 * At most this much of the log is read in one go: the detector needs the
 * trailing hour (~120 ticks of ~1.7 KB), and the log runs to 4 MB before the
 * monitor rotates it, so a read starting further back than this starts here
 * instead — at boot, after any gap the reader was not watching, and after a
 * rotation (a replaced file holding the trailing two hours).
 */
export const TAIL_BYTES = 512 * 1024;

/** Where the reader has consumed the log up to: a complete line boundary of one file. */
export interface LogCursor {
  ino: number;
  offset: number;
}

export type TailRead =
  | { kind: "missing" }
  | { kind: "read"; ticks: MonitorTick[]; cursor: LogCursor };

function isNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * The complete lines appended to `path` since `cursor`, parsed. Starts over at
 * the tail (the last {@link TAIL_BYTES}, its first partial line dropped) when
 * there is no cursor, the file was replaced (another inode) or truncated, or
 * more than the tail was appended since. A last line still without its
 * newline is left for the next read. A missing file is `missing`, not an
 * error: it means the monitor was never installed.
 */
export async function readLogTail(
  path: string,
  cursor: LogCursor | null,
  tailBytes: number = TAIL_BYTES,
): Promise<TailRead> {
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    if (isNotFound(err)) return { kind: "missing" };
    throw err;
  }
  const size = st.size;
  const resume =
    cursor !== null &&
    cursor.ino === st.ino &&
    cursor.offset <= size &&
    size - cursor.offset <= tailBytes;
  const start = resume ? cursor.offset : Math.max(0, size - tailBytes);
  if (start === size)
    return { kind: "read", ticks: [], cursor: { ino: st.ino, offset: size } };
  const fh = await open(path, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    buf = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  // Cut at the last newline in bytes, so a line still being written is left whole for the next read.
  const end = buf.lastIndexOf(0x0a);
  if (end === -1)
    return { kind: "read", ticks: [], cursor: { ino: st.ino, offset: start } };
  const lines = buf.subarray(0, end).toString("utf8").split("\n");
  // Starting mid-file, the first line is the tail of one we never saw whole.
  if (!resume && start > 0) lines.shift();
  const ticks = lines.filter((l) => l.trim() !== "").map(parseTickLine);
  return {
    kind: "read",
    ticks,
    cursor: { ino: st.ino, offset: start + end + 1 },
  };
}
