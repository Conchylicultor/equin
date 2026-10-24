import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { serveValue, sliceRange } from "@plugins/network/plugins/live/server";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { releaseRunLogs } from "../../core/resources";
import {
  forgetReleaseTranscript,
  isReleaseRunId,
  releaseTranscriptLines,
  releaseTranscriptPath,
} from "./transcript";

/**
 * Watch one run's transcript for as long as its logs are read, through the
 * shared dir hub (a children-scope watch of the supervised-runs directory —
 * every run's transcript sits directly in it).
 *
 * The directory is created if absent: it is the supervised-run family's own
 * home (the supervisor creates the same one before its first run), and a
 * namespace that never ran a release still has a valid, empty answer to watch.
 */
async function watchTranscript(
  releaseId: string,
  notify: () => void,
): Promise<() => void> {
  const path = releaseTranscriptPath(releaseId);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const file = basename(path);
  const release = await acquireDirWatch({
    dir,
    scope: "children",
    onChange: (events) => {
      if (events.some((e) => basename(e.path) === file)) notify();
    },
  });
  // A write between the first load and the watch opening produced no event;
  // one re-read closes that gap.
  notify();
  return release;
}

/**
 * The persisted log of one release run — its transcript file, a key range of
 * lines at a time (newest first), sliced from the lines memoized on the file's
 * `(size, mtime)` (`releaseTranscriptLines`), so the pages of one change read
 * the file once.
 *
 * `notified`, by the transcript's own watch: a live run's file grows, the
 * artifact prune can reap a finished one, and a terminal run's never changes
 * again, so the watch is silent exactly when the answer is immutable. That is
 * the honest single form: "immutable once terminal" would need the loader to
 * read the `release_runs` row to know which arm a tuple is in, and an external
 * loader reads no Postgres.
 *
 * Throttled: a live run writes its transcript line by line, and each recompute
 * re-reads the file.
 */
export const releaseRunLogsServed = serveValue(releaseRunLogs, {
  source: "external",
  changes: "notified",
  throttleMs: 1000,
  loader: async ({ id }, range) => {
    if (!isReleaseRunId(id)) {
      throw releaseRunLogs.refuse(
        "invalid-id",
        `not a release run id: ${JSON.stringify(id)}`,
      );
    }
    return sliceRange(releaseRunLogs, await releaseTranscriptLines(id), range);
  },
  // Once per run, however its pages split. The async start is RETURNED to the
  // runtime, which awaits it before the first read, reports a failed start,
  // and chains a stop that arrives first after it. A malformed id watches
  // nothing — the loader refuses it. The stop drops the memoized lines.
  whileSubscribed: async ({ id }, notify) => {
    if (!isReleaseRunId(id)) return () => {};
    const release = await watchTranscript(id, notify);
    return () => {
      release();
      forgetReleaseTranscript(id);
    };
  },
});
