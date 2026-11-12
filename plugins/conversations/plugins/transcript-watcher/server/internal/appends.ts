import { resolveConversationTranscriptPaths } from "./resolve-chain";
import { conversationChainTag, watchPaths } from "./watcher";

const NEWLINE = 0x0a;
/** How much of a file a backward scan reads per step. */
const BACK_CHUNK = 64 * 1024;

/**
 * A backward scan's judge, made fresh for each file it scans: whether it takes
 * `line` (newest first) and goes on, or stops before it.
 */
export type SeedBack = () => (line: Record<string, unknown>) => "take" | "stop";

/** What one read of a followed chain hands its listener. */
export interface TranscriptAppends {
  /**
   * Lines the listener had not seen, in file order: for a file met for the
   * first time, the trailing lines `seedBack` took (`seed: true`); then every
   * complete line appended since the last read (`seed: false`).
   */
  lines: { line: Record<string, unknown>; seed: boolean }[];
}

/** One chain file as followed: which file (its inode), and the offset its next append starts at. */
interface FollowedFile {
  path: string;
  dev: number;
  ino: number;
  offset: number;
}

interface AppendsRead {
  files: FollowedFile[];
  delivery: TranscriptAppends;
}

let nextRoom = 0;

/**
 * Follow a conversation's session chain from NOW: the listener gets the lines
 * appended after it subscribed, never the chain's history — so subscribing
 * costs a stat per chain file and a short backward read, not a parse of the
 * whole transcript.
 *
 * A file met for the first time — at subscribe, a session switch adding a file
 * to the chain, or a file replaced or cut short (a rewind) — starts at its
 * current end. Its last lines, read backwards while `seedBack` takes them, are
 * handed over first as `seed` lines: the context a listener needs to judge the
 * appends that follow (the turn-emitter's turn in progress). A line its writer
 * has not finished is left for the next read.
 *
 * Not shared: every call is its own room (an append stream starts at its own
 * subscriber's now, so there is nothing a second subscriber could join).
 */
export function watchTranscriptAppends(
  conversationId: string,
  seedBack: SeedBack,
  onAppends: (appends: TranscriptAppends) => void,
): () => void {
  return watchPaths<AppendsRead>(
    {
      key: `transcript-appends:${conversationId}:${nextRoom++}`,
      refreshOn: conversationChainTag(conversationId),
      resolve: async () => ({
        paths: await resolveConversationTranscriptPaths(conversationId),
      }),
      read: (paths, previous) => readAppends(paths, previous, seedBack),
    },
    ({ value }) => {
      if (value.delivery.lines.length > 0) onAppends(value.delivery);
    },
  );
}

export async function readAppends(
  paths: readonly string[],
  previous: AppendsRead | undefined,
  seedBack: SeedBack,
): Promise<AppendsRead> {
  const lines: TranscriptAppends["lines"] = [];
  const files: FollowedFile[] = [];
  for (const path of paths) {
    let st;
    try {
      st = await Bun.file(path).stat();
    } catch (err) {
      // A chain entry whose transcript has not landed yet (as `readChain`).
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue;
    }
    const was = previous?.files.find(
      (f) => f.path === path && f.dev === st.dev && f.ino === st.ino,
    );
    if (was && st.size >= was.offset) {
      const { decoded, consumed } = splitLines(
        await Bun.file(path).slice(was.offset, st.size).bytes(),
      );
      for (const line of decoded) lines.push({ line, seed: false });
      files.push({ ...was, offset: was.offset + consumed });
    } else {
      const { taken, end } = await readBack(path, st.size, seedBack);
      for (const line of taken) lines.push({ line, seed: true });
      files.push({ path, dev: st.dev, ino: st.ino, offset: end });
    }
  }
  return { files, delivery: { lines } };
}

/** The complete lines of `bytes` (an unterminated last line is left), and how many bytes they span. */
function splitLines(bytes: Uint8Array): {
  decoded: Record<string, unknown>[];
  consumed: number;
} {
  const decoder = new TextDecoder();
  const decoded: Record<string, unknown>[] = [];
  let start = 0;
  for (;;) {
    const end = bytes.indexOf(NEWLINE, start);
    if (end === -1) break;
    const line = decodeLine(decoder.decode(bytes.subarray(start, end)));
    if (line) decoded.push(line);
    start = end + 1;
  }
  return { decoded, consumed: start };
}

/**
 * Read `path` backwards from `size`: the offset just past its last complete
 * line (`end`), and the lines before it that `seedBack` takes, in file order.
 * Reads a chunk at a time, so it costs the lines it takes, not the file.
 */
async function readBack(
  path: string,
  size: number,
  seedBack: SeedBack,
): Promise<{ taken: Record<string, unknown>[]; end: number }> {
  const judge = seedBack();
  const file = Bun.file(path);
  const decoder = new TextDecoder();
  const taken: Record<string, unknown>[] = [];
  // Bytes not yet split into lines, ending at `bufEnd`; `bufStart` is where
  // they begin in the file.
  let buf = new Uint8Array(0);
  let bufStart = size;
  let end: number | null = null;
  while (bufStart > 0) {
    const from = Math.max(0, bufStart - BACK_CHUNK);
    const chunk = await file.slice(from, bufStart).bytes();
    const joined = new Uint8Array(chunk.length + buf.length);
    joined.set(chunk, 0);
    joined.set(buf, chunk.length);
    buf = joined;
    bufStart = from;
    // The file's last complete line ends at its last newline.
    if (end === null) {
      const last = buf.lastIndexOf(NEWLINE);
      if (last === -1) continue;
      end = bufStart + last + 1;
      buf = buf.subarray(0, last + 1);
    }
    // Split off every line whose start is known (it follows a newline, or the
    // file starts here), newest first.
    let lineEnd = buf.length - 1; // index of the newline ending the newest unsplit line
    for (;;) {
      const prev = lineEnd > 0 ? buf.lastIndexOf(NEWLINE, lineEnd - 1) : -1;
      if (prev === -1 && bufStart > 0) break; // its start is in an earlier chunk
      const line = decodeLine(decoder.decode(buf.subarray(prev + 1, lineEnd)));
      if (line) {
        if (judge(line) === "stop") return { taken: taken.reverse(), end };
        taken.push(line);
      }
      if (prev === -1) return { taken: taken.reverse(), end };
      lineEnd = prev;
    }
    buf = buf.subarray(0, lineEnd + 1);
  }
  return { taken: taken.reverse(), end: end ?? 0 };
}

/** One line's JSON object, or null for a blank line or one that is not a JSON object (skipped, as the parser does). */
function decodeLine(text: string): Record<string, unknown> | null {
  if (text.length === 0) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}
