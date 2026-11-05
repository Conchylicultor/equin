import { claudeTranscriptPath } from "@plugins/infra/plugins/paths/server";
import { access } from "@plugins/packages/plugins/timed-fs/core";

/**
 * The transcript of `sessionId` run in `cwd`, or `null` when it is not on
 * disk — Claude Code has not written it yet, or retention GC'd it.
 *
 * A lookup, not a search: Claude Code files a session under the projects dir
 * its cwd names (`claudeTranscriptPath`), so this is one `access` of the one
 * path it can be at. It used to glob `*\/<id>.jsonl` over every projects dir
 * (~1,700 on a busy host) on each call, and a miss — most chain ids, once
 * retention has run — paid it every time. It also means a session run in
 * another directory (another conversation's) cannot be found at all: a
 * conversation's chain only ever resolves to its own transcripts.
 */
export async function findTranscriptPath(
  cwd: string,
  sessionId: string,
): Promise<string | null> {
  const path = claudeTranscriptPath(cwd, sessionId);
  try {
    await access(path);
    return path;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
