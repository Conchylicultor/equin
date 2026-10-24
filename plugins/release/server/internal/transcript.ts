import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import { releaseLogLineKey, type ReleaseLogLine } from "../../core/resources";
import { RELEASE_RUN_KIND_ID } from "./kind-id";

/**
 * Every line one release run wrote, read back from its transcript file, in
 * line order — each keyed by its 1-based line number (`releaseLogLineKey`).
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
 * - **Every line is kept, not a tail.** A cap would have to drop the START of
 *   a release log, which is where its phase headers are. The reader pages it
 *   (`releaseRunLogs`), so the browser never holds it whole; the file's own
 *   bound is the supervised-run artifact prune (newest 50 runs per kind).
 *
 * The parsed lines are memoized on the file's `(size, mtime)`: every page of a
 * run slices one array, and a recompute after a write the file did not see
 * (another file of the directory) re-reads nothing. A missing transcript reads
 * as no lines. That is not a swallowed failure — the prune reaps the oldest
 * run sets, and a run whose transcript is gone genuinely has nothing to show.
 * The stat and the read are asynchronous: a page loads inside the runtime's
 * shared flush, which a synchronous read of a large transcript would stall.
 */
export function releaseTranscriptLines(
  releaseId: string,
): Promise<readonly ReleaseLogLine[]> {
  return readLineIndex(
    releaseTranscriptPath(releaseId),
    lineIndexes,
    releaseId,
  );
}

/** Drop a run's memoized lines — its log is no longer read. */
export function forgetReleaseTranscript(releaseId: string): void {
  lineIndexes.delete(releaseId);
}

/** One transcript's parsed lines, and the `(size, mtime)` they were read at. */
export interface LineIndex {
  size: number;
  mtimeMs: number;
  lines: readonly ReleaseLogLine[];
}

const lineIndexes = new Map<string, LineIndex>();

/**
 * The lines of the file at `path`, re-read only when its `(size, mtime)` moved
 * since `cache` last held them under `key`. The stat is taken BEFORE the read:
 * a write landing in between leaves the cached pair older than the bytes, so
 * the next call sees a different pair and re-reads — never the reverse.
 */
export async function readLineIndex(
  path: string,
  cache: Map<string, LineIndex>,
  key: string,
): Promise<readonly ReleaseLogLine[]> {
  const st = await statIfPresent(path);
  if (st === null) {
    cache.delete(key);
    return [];
  }
  const cached = cache.get(key);
  if (cached?.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return cached.lines;
  }
  const text = (await readIfPresent(path)) ?? "";
  const pieces = text.split("\n");
  // A transcript ends in a newline unless the child died mid-line, so the last
  // piece is usually empty — and a genuinely unterminated last line is the one
  // most worth keeping, so it is only the empty case that is dropped.
  if (pieces.at(-1) === "") pieces.pop();
  const lines = pieces.map((line, i): ReleaseLogLine => ({
    n: releaseLogLineKey(i + 1),
    text: line,
    stream: "stdout",
  }));
  cache.set(key, { size: st.size, mtimeMs: st.mtimeMs, lines });
  return lines;
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

/** Stat a file, or null when it is not there. Any other fs error is a real fault. */
async function statIfPresent(
  path: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await stat(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Read a file, or null when it is not there. Any other fs error is a real fault. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
