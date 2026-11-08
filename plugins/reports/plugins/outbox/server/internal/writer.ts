import { sinkHandler } from "@plugins/framework/plugins/server-core/core";
import {
  reportOutboxFatalSink,
  reportOutboxSink,
} from "@plugins/reports/plugins/engine/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  fileReportFromProcess,
  fileReportFromProcessSync,
  headCommitOf,
  repositoryOf,
} from "../../core";

// The writes still in flight: a process must not exit before they land.
const inFlight = new Set<Promise<unknown>>();

/**
 * The engine's `reportOutboxSink` → the outbox: a report `recordReport` was
 * asked to file in a process that cannot write `reports` (an exec child, a
 * CLI) becomes one outbox entry. A `sinkHandlers` entry, attached in every
 * boot mode. `fileReportFromProcess` never rejects (it prints why it failed).
 */
export const outboxWriter = sinkHandler(reportOutboxSink, () => (input) => {
  const write: Promise<void> = runTracked("report-outbox:write", async () => {
    try {
      await fileReportFromProcess({
        kind: input.kind,
        message: input.message ?? "",
        data: input.data,
        // recordReport stamped this process's pin (or the caller's commit).
        commit: input.commit ?? null,
      });
    } finally {
      inFlight.delete(write);
    }
  });
  inFlight.add(write);
});

/** Every outbox write started so far, landed — before the process exits. */
export async function settleOutboxWrites(): Promise<void> {
  await Promise.all(inFlight);
}

// This checkout's repository, for the synchronous writer's `writer.repo`:
// resolving it spawns git, which a process on its way out cannot await. Read
// once in `onReadyBlocking` (`resolveWriterRepo`), before any registered work
// runs.
let writerRepo: string | undefined;
// This checkout's HEAD, for the synchronous writer's `writer.commit` — read
// beside `writerRepo`, for the same reason. Null until then, and when git
// cannot name it.
let writerCommit: string | null = null;

/**
 * Resolve the repository the synchronous writer stamps. Throws like the
 * drain's own read of it (`repositoryOf`): the app runs from a git checkout,
 * and one git cannot read is a broken assumption to fail on, not to stamp
 * around.
 */
export async function resolveWriterRepo(): Promise<void> {
  writerRepo = await repositoryOf(REPO_ROOT);
  writerCommit = await headCommitOf(REPO_ROOT);
}

/**
 * The engine's `reportOutboxFatalSink` → the outbox, synchronously: a fatal
 * report (`exitWithFatalReport`) from a process that cannot write `reports`
 * — an exec child exiting on purpose — is one entry, renamed into place before
 * the handler returns, so the caller may exit on its next statement. Answers
 * whether it landed (a refusal or failure has printed why).
 */
export const outboxFatalWriter = sinkHandler(
  reportOutboxFatalSink,
  () => (report) =>
    fileReportFromProcessSync(
      { kind: report.kind, message: report.message, data: report.data ?? {} },
      { repo: writerRepo, commit: writerCommit },
    ).outcome === "written",
);
