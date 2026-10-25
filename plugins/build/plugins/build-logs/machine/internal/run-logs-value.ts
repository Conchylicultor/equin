import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { sliceRange } from "@plugins/network/plugins/live/server";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import {
  worktreeArtifacts,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/server";
import { isRunId } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { onSupervisedRunChange } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { BUILD_RUN_KIND_ID } from "@plugins/build/plugins/run-ledger/core";
import { buildRunLogs } from "../../core/run-logs";
import {
  forgetBuildRunLog,
  heldBuildRunLog,
  type BuildRunLog,
} from "./run-log";

/**
 * Watch every file one run's log is read from, for as long as it is read.
 *
 * - **The transcript and the exit marker** (the supervised-runs directory) are
 *   heard through the supervisor itself (`onSupervisedRunChange`): it already
 *   follows that directory with its one `writesWhileOpen` subscription while a
 *   run is live — which is what makes a RUNNING build's log move, since the
 *   detached child writes its transcript through a descriptor it holds open for
 *   the whole run and macOS FSEvents (the dir hub) reports that file only when
 *   it closes — and it calls back on every tail pump and on the run's settle. A
 *   second kqueue subscription per reader would cost one descriptor per runs
 *   entry and a recursive listing per open pane, unheld by the artifact prune.
 *   A run this process is not tailing is over: its two files never change again.
 * - **The CLI's step log** (the data directory) through the shared dir hub: it
 *   is written once, atomically, at the end — the terminal record of a hand-run
 *   build too, which has no transcript or marker.
 */
async function watchRunLog(
  buildId: string,
  notify: () => void,
): Promise<() => void> {
  const ns = runtimeNamespace();
  const stepLog = basename(worktreeArtifacts.buildLogs(ns, buildId));
  const dataDir = worktreeDataDir(ns);
  const stopRun = onSupervisedRunChange(BUILD_RUN_KIND_ID, buildId, notify);
  try {
    await mkdir(dataDir, { recursive: true });
    const releaseData = await acquireDirWatch({
      dir: dataDir,
      scope: "children",
      onChange: (events) => {
        if (events.some((e) => basename(e.path) === stepLog)) notify();
      },
    });
    return () => {
      stopRun();
      releaseData();
    };
  } catch (err) {
    stopRun();
    throw err;
  }
}

/** The run's log, or the refusal that says why there is none. */
async function runLogOf(id: string): Promise<BuildRunLog> {
  // Gated on what the id is joined into — a filename — not on the build-run id
  // kind: live `build_runs` rows still carry the hand-run `<shortCommit>-<ms>`
  // shape, which names no id kind but does name a log on disk.
  if (!isRunId(id)) {
    throw buildRunLogs.refuse(
      "invalid-id",
      `not a build run id: ${JSON.stringify(id)}`,
    );
  }
  const log = await heldBuildRunLog(id);
  if (log === null) {
    throw buildRunLogs.refuse("missing", `build run ${id} has no log on disk`);
  }
  return log;
}

/**
 * The persisted log of one build run — a key range of its lines at a time
 * (newest first), sliced from the log memoized on its files' `(size, mtime)`,
 * so the pages and the meta of one change read the files once.
 *
 * `notified`, by the watches of the files it is read from: a running build's
 * transcript grows, its exit marker and step log land when it ends — and after
 * that nothing writes them again, so the watch is silent exactly when the
 * answer is immutable. That is the honest single form: "notified while live,
 * immutable once terminal" cannot be one value's arms (freshness is declared
 * per serve call, not per tuple). A prune reaping a finished run's files is not
 * heard: the open pane keeps the log it read until it re-subscribes.
 *
 * Throttled: a running build writes its transcript line by line, and each
 * recompute re-reads the file.
 */
export const buildRunLogsServed = serveValue(buildRunLogs, {
  source: "external",
  changes: "notified",
  throttleMs: 1000,
  loader: async ({ id }, range) =>
    sliceRange(buildRunLogs, (await runLogOf(id)).lines, range),
  meta: async ({ id }) => ({ steps: (await runLogOf(id)).steps }),
  // Once per run, however its pages split. The async start is RETURNED to the
  // runtime, which awaits it before the first read, reports a failed start,
  // and chains a stop that arrives first after it. An id that cannot name a
  // file watches nothing — the loader refuses it. The stop drops the memoized
  // log.
  whileSubscribed: async ({ id }, notify) => {
    if (!isRunId(id)) return () => {};
    const release = await watchRunLog(id, notify);
    return () => {
      release();
      forgetBuildRunLog(id);
    };
  },
});
