import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { claudeTranscriptPath } from "@plugins/infra/plugins/paths/core";

/**
 * Write one session's JSONL (overwriting the last seed's) where Claude Code
 * would have written it for a session run in `cwd` — the projects dir its
 * cwd names — which is where the desktop's transcript watcher looks it up
 * (`transcript-watcher`'s `findTranscriptPath`).
 */
export async function writeSessionFile(
  cwd: string,
  sessionId: string,
  jsonl: string,
): Promise<string> {
  const path = claudeTranscriptPath(cwd, sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, jsonl);
  return path;
}
