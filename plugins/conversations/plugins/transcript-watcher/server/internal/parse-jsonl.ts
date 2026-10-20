import {
  buildJsonlEvents,
  mergeChainLines,
} from "@plugins/conversations/plugins/transcript-source/server";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

// The session files on disk, through the transcript parser
// (`transcript-source`): this host's reads of a chain and of the images its
// prompts reference.

/**
 * Read every file of a session chain and merge them. A chain entry whose
 * transcript has not landed on disk yet is skipped (the status reconciler records the
 * session id before Claude writes the file); any other read failure propagates.
 */
export async function readChainLines(
  paths: string[],
): Promise<Record<string, unknown>[]> {
  const files: { path: string; raw: string }[] = [];
  for (const path of paths) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    files.push({ path, raw: await file.text() });
  }
  return mergeChainLines(files);
}

export function readJsonlEvents(path: string): Promise<JsonlEvent[]> {
  return readJsonlEventsFromChain([path]);
}

export async function readJsonlEventsFromChain(
  paths: string[],
): Promise<JsonlEvent[]> {
  return buildJsonlEvents(await readChainLines(paths), readImageFile);
}

/** A prompt's referenced image from disk, as base64; `null` when unreadable. */
async function readImageFile(path: string): Promise<string | null> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    return Buffer.from(await f.arrayBuffer()).toString("base64");
  } catch (err) {
    if (!(err instanceof Error) || !("code" in err)) throw err;
    // File system error (ENOENT, EACCES, etc.) — treat as missing image; render as text
    return null;
  }
}
