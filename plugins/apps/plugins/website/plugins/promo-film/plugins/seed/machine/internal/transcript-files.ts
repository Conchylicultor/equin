import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_PROJECTS_DIR } from "@plugins/infra/plugins/paths/core";

/**
 * Where the film's session files go: one project folder of their own under
 * Claude Code's projects dir, which is where the desktop's transcript watcher
 * finds a session by id (`transcript-watcher`'s `findTranscriptPath`).
 */
const FILM_PROJECT_DIR = join(CLAUDE_PROJECTS_DIR, "-equin-promo-film");

/** Write one session's JSONL (overwriting the last seed's). */
export async function writeSessionFile(
  sessionId: string,
  jsonl: string,
): Promise<string> {
  await mkdir(FILM_PROJECT_DIR, { recursive: true });
  const path = join(FILM_PROJECT_DIR, `${sessionId}.jsonl`);
  await writeFile(path, jsonl);
  return path;
}
