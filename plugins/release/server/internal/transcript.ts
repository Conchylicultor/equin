import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import type { ReleaseLogLine } from "../../core/endpoints";
import { RELEASE_RUN_KIND_ID } from "./kind-id";

/**
 * Every line one release run wrote, read back from its transcript file.
 *
 * **This replaces `release-logs-<id>.json`, and the replacement is the point of
 * the migration rather than a side effect of it.** That artifact was written by
 * the PARENT, from lines it had accumulated off the CLI's pipe, and only when
 * the run failed. So it existed exactly when the parent survived the run — which
 * is the case that never needed it — and was absent for every run that was
 * genuinely orphaned, the case it was written for. Its other reader,
 * `resolveOrphanExitCode`, is deleted for the same reason.
 *
 * The transcript is written by the CHILD, through a kernel fd, for every run
 * whatever becomes of it. So this now answers for a successful run too (which
 * previously showed an empty log pane once its live stream ended) and for one
 * whose backend went away mid-flight.
 *
 * Two honest consequences:
 *
 * - **Every line reads as `stdout`.** A supervised child's stdout and stderr
 *   share one descriptor, so the interleaving survives and the per-line
 *   classification does not. This is not a claim invented here: the live view of
 *   the same bytes already says `stdout`, because the log channel defaults an
 *   unclassified line to it. The persisted view now agrees with the live one
 *   instead of contradicting it.
 * - **The whole file is read, not a tail.** A cap would have to drop the START
 *   of a release log, which is where its phase headers are, and the artifact it
 *   replaces was uncapped too. The file's own bound is the supervised-run
 *   artifact prune (newest 50 runs per kind).
 *
 * A missing transcript reads as no lines. That is not a swallowed failure — the
 * prune reaps the oldest run sets, and a run whose transcript is gone genuinely
 * has nothing to show.
 */
export function readReleaseTranscript(releaseId: string): ReleaseLogLine[] {
  const text = readIfPresent(releaseTranscriptPath(releaseId));
  if (text === null) return [];
  const lines = text.split("\n");
  // A transcript ends in a newline unless the child died mid-line, so the last
  // piece is usually empty — and a genuinely unterminated last line is the one
  // most worth keeping, so it is only the empty case that is dropped.
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => ({ text: line, stream: "stdout" as const }));
}

/**
 * Whether an id can name a transcript: it becomes a filename, so it must be one
 * non-empty path segment. The live value refuses any other id before it reads
 * or watches anything.
 */
export function isReleaseRunId(releaseId: string): boolean {
  return releaseId !== "" && basename(releaseId) === releaseId;
}

/**
 * Where one release run's transcript lives. The id becomes a filename, so one
 * that is not a single path segment is refused rather than resolved somewhere
 * else on disk (callers check `isReleaseRunId` first; this is the backstop).
 */
export function releaseTranscriptPath(releaseId: string): string {
  if (!isReleaseRunId(releaseId)) {
    throw new Error(`not a release run id: ${JSON.stringify(releaseId)}`);
  }
  return worktreeArtifacts.runTranscript(
    runtimeNamespace(),
    RELEASE_RUN_KIND_ID,
    releaseId,
  );
}

/** Read a file, or null when it is not there. Any other fs error is a real fault. */
function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
