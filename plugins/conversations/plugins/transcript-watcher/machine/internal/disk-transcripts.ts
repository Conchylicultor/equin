import { lstat, open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  readImageKey,
  TranscriptImageKeyError,
  type TranscriptImageIo,
  type TranscriptSourceImpl,
} from "@plugins/conversations/plugins/transcript-source/server";
import { CLAUDE_PROJECTS_DIR } from "@plugins/infra/plugins/paths/server";
import { resolveConversationTranscriptPaths } from "../../server/internal/resolve-chain";
import { transcriptChainSignature } from "../../server/internal/chain-signature";
import { readJsonlEventsFromChain } from "../../server/internal/parse-jsonl";
import { watchTranscript } from "../../server/internal/watcher";

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|bmp|tiff)$/i;

/**
 * An image key names a file by path, so the host decides which files a key may
 * read: a transcript line only from a `.jsonl` under the projects directory,
 * and a prompt's image only from an image file. Anything else is not a key
 * this host minted.
 */
function assertTranscriptFile(file: string): void {
  const path = resolve(file);
  if (!path.startsWith(CLAUDE_PROJECTS_DIR + sep) || !path.endsWith(".jsonl")) {
    throw new TranscriptImageKeyError(`not a transcript file: ${file}`);
  }
}

const diskImageIo: TranscriptImageIo = {
  readRange: async (file, offset, length) => {
    assertTranscriptFile(file);
    let handle;
    try {
      handle = await open(file, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      const bytes = new Uint8Array(length);
      const { bytesRead } = await handle.read(bytes, 0, length, offset);
      return bytes.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
  readPath: async (path) => {
    if (!IMAGE_EXTENSION.test(path)) {
      throw new TranscriptImageKeyError(`not an image file: ${path}`);
    }
    try {
      const st = await lstat(path);
      if (!st.isFile()) return null;
      const bytes = await Bun.file(path).bytes();
      return { mtimeMs: st.mtimeMs, size: st.size, bytes };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
};

/**
 * The desktop's transcripts: Claude Code's session files on disk. Both halves
 * resolve the chain first, the signature being the chain's per-file (path,
 * mtime, size) — a faithful function of every input the read parses, so a
 * value ETagged by it can never be served stale. The watch is the single
 * transcript watcher, which reads the chain incrementally and hands the events
 * and the signature they were read under as one pair. An image is read back
 * from the line (or file) its key names.
 */
export const diskTranscripts: TranscriptSourceImpl = {
  signature: async (id) =>
    transcriptChainSignature(await resolveConversationTranscriptPaths(id)),
  events: async (id) =>
    readJsonlEventsFromChain(await resolveConversationTranscriptPaths(id)),
  watch: watchTranscript,
  image: (key) => readImageKey(key, diskImageIo),
};
