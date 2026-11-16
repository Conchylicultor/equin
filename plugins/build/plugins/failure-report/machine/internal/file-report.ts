import {
  isMain,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import { recordReportIncident } from "@plugins/reports/plugins/engine/server";
import { BUILD_RUN_KIND_ID } from "@plugins/build/plugins/run-ledger/core";
import { parseStepBlocks } from "@plugins/framework/plugins/cli/plugins/op-runtime/core";
import {
  BUILD_FAILED_KIND,
  buildFailedMessage,
  buildFailureOf,
  type BuildFailedPayload,
} from "../../core";
import { linkRunReport, runReportIds } from "../../server";

/** The ledger row of the failed run, as the build's bell already read it. */
export interface FailedBuildRun {
  runId: string;
  /** The run's page — every occurrence's `url`, what its task finds the report by. */
  url: string;
  /** The live task already filed about this run, if any (an Investigate clicked before the report landed). */
  findTask: () => Promise<string | null>;
  /** When the run ended — the occurrence's instant (a boot catch-up files it late). */
  finishedAt: Date;
  commitHash: string | null;
  exitCode: number;
  trigger: string;
  targets: string[];
}

/** The run's transcript lines, or `null` when it has none on disk. */
async function readTranscript(runId: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await readFile(
      worktreeArtifacts.runTranscript(
        runtimeNamespace(),
        BUILD_RUN_KIND_ID,
        runId,
      ),
      "utf-8",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * File a failed build of MAIN as a `build-failed` report. Called right after
 * the build's own bell, where its outcome is told (build/machine's
 * `onBuildEnded` and `onAutoBuildTerminal`), for the `failed` status only:
 * superseded, killed and interrupted runs are not a verdict on the code and
 * file nothing. Idempotent per run, so a retried telling files once.
 *
 * Main only. An agent worktree's failed build is that agent's own feedback
 * loop (≈1 in 5 worktree builds fail; 3 of ~170 of main's did over two days),
 * and a report of it would be a report about unfinished work.
 *
 * Filed with `alert: false`: the build's own "Build failed" bell — whose Fix
 * files the Investigate task that owns this report — already announces this
 * occurrence, so a second bell would tell one failure twice. The row, its
 * count, the fix ledger and the Error reports stream are unaffected.
 *
 * The occurrence's commit is the commit the BUILD built, not this backend's
 * pin: that is the code that failed, and what a fix's regression is judged on.
 */
export async function fileBuildFailureReport(
  run: FailedBuildRun,
): Promise<void> {
  if (!isMain()) return;
  // Once per run: a retried `onEnded` (or any second telling) must not count
  // the same failure twice. The run's occurrence carries its page as `url`.
  const filed = (await runReportIds(run.url)).length > 0;
  if (!filed) await record(run);
  // A task about this run filed before the report landed owns it too. The
  // stream event the record enqueued re-reads the row and skips an owned one.
  const taskId = await run.findTask();
  if (taskId !== null) await linkRunReport(run.url, taskId);
}

async function record(run: FailedBuildRun): Promise<void> {
  const lines = await readTranscript(run.runId);
  const failure = buildFailureOf(parseStepBlocks(lines ?? []));
  const data: BuildFailedPayload = {
    runId: run.runId,
    commit: run.commitHash,
    targets: run.targets.slice(0, 32),
    trigger: run.trigger,
    exitCode: run.exitCode,
    ...failure,
    noTranscript: lines === null,
  };
  await recordReportIncident(
    [
      {
        kind: BUILD_FAILED_KIND,
        source: "server-build",
        message: buildFailedMessage(data),
        url: run.url,
        commit: run.commitHash,
        occurredAt: run.finishedAt.getTime(),
        data,
      },
    ],
    { alert: false },
  );
}
