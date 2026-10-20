import {
  encodeImageKey,
  TranscriptLines,
} from "@plugins/conversations/plugins/transcript-source/server";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

// The session files on disk, through the transcript parser
// (`transcript-source`): this host's reads of a chain and of the images its
// prompts reference.

/** One chain file as it was when last read: which file (its inode), and how big. */
interface ReadFile {
  path: string;
  dev: number;
  ino: number;
  size: number;
}

/**
 * A chain read so far — what an incremental read continues from. `lines` holds
 * every complete line of `files`, in chain order.
 */
export interface ChainRead {
  lines: TranscriptLines;
  files: ReadFile[];
}

type ChainStatEntry = ReadFile;

async function statChainFiles(
  paths: readonly string[],
): Promise<ChainStatEntry[]> {
  const out: ChainStatEntry[] = [];
  for (const path of paths) {
    try {
      const st = await Bun.file(path).stat();
      out.push({ path, dev: st.dev, ino: st.ino, size: st.size });
    } catch (err) {
      // A chain entry whose transcript has not landed on disk yet is skipped
      // (the status reconciler records the session id before Claude writes the
      // file); any other failure propagates.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return out;
}

/**
 * Whether `previous` can be continued into the chain as it is now: the same
 * files, in the same order, each still the same file (a rewind renames the old
 * one away and writes a new one), none shorter than what was read, and only the
 * LAST one grown — a line appended to an earlier file would land after lines of
 * later ones. New files may follow. Anything else is read again from scratch.
 * (An earlier file is compared by size, not by what was consumed of it: one
 * ending in a line its writer never finished stays continuable.)
 */
function continues(
  previous: ChainRead,
  now: readonly ChainStatEntry[],
): boolean {
  const before = previous.files;
  if (now.length < before.length) return false;
  for (let i = 0; i < before.length; i++) {
    const was = before[i]!;
    const is = now[i]!;
    if (is.path !== was.path || is.ino !== was.ino || is.dev !== was.dev) {
      return false;
    }
    if (is.size < was.size) return false;
    if (i < before.length - 1 && is.size !== was.size) return false;
  }
  return true;
}

/**
 * Read a session chain, continuing `previous` when the files allow it — so an
 * append costs the bytes appended, not the chain. Without a `previous` (or when
 * it cannot be continued) it is a full read.
 */
export async function readChain(
  paths: readonly string[],
  previous?: ChainRead,
): Promise<ChainRead> {
  const now = await statChainFiles(paths);
  const read: ChainRead =
    previous && continues(previous, now)
      ? previous
      : { lines: new TranscriptLines(keyPromptImage), files: [] };
  for (const file of now) {
    const consumed = read.lines.consumed(file.path);
    if (file.size <= consumed) continue;
    const bytes = await Bun.file(file.path).slice(consumed, file.size).bytes();
    read.lines.append(file.path, consumed, bytes);
  }
  read.files = now;
  return read;
}

/**
 * Read every file of a session chain and merge them. A chain entry whose
 * transcript has not landed on disk yet is skipped; any other read failure
 * propagates.
 */
export async function readChainLines(
  paths: string[],
): Promise<readonly Record<string, unknown>[]> {
  return (await readChain(paths)).lines.lines();
}

export function readJsonlEvents(path: string): Promise<JsonlEvent[]> {
  return readJsonlEventsFromChain([path]);
}

export async function readJsonlEventsFromChain(
  paths: string[],
): Promise<JsonlEvent[]> {
  return (await readChain(paths)).lines.events();
}

/**
 * A prompt's referenced image (`@/path.png`) as a key the page loads it by —
 * the file's path and (mtime, size), so the key names these bytes and no later
 * ones; `null` when there is no such file, which renders the reference as text.
 */
async function keyPromptImage(path: string): Promise<string | null> {
  try {
    const st = await Bun.file(path).stat();
    if (!st.isFile()) return null;
    return encodeImageKey({
      kind: "path",
      path,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  } catch (err) {
    if (!(err instanceof Error) || !("code" in err)) throw err;
    // File system error (ENOENT, EACCES, etc.) — treat as missing image; render as text
    return null;
  }
}
