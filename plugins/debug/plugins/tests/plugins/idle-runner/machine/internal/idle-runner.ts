import { z } from "zod";
import { db } from "@plugins/database/server";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { TESTS_FAILED_EXIT } from "@plugins/framework/plugins/cli/plugins/test/plugins/record/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import {
  cancelSupervisedJobByLock,
  defineSupervisedJob,
  latestSupervisedRun,
} from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { readHostIdleRecord } from "@plugins/infra/plugins/host/plugins/idle/server";
import { _testFileStatus } from "@plugins/debug/plugins/tests/server";
import {
  ingestRunRecordsNow,
  requestCheckoutDigests,
} from "@plugins/debug/plugins/tests/machine";
import { fileTestFailingReports } from "@plugins/debug/plugins/tests/plugins/failing-report/machine";
import { selectIdleBatch } from "./select-batch";

// The idle runner: while the host is idle (infra/host/idle — no agent working,
// no op running, no duress, for 10 min), run the test files whose status on
// the current code is unknown, one small batch after another, and stop the
// moment the host is needed.
//
//   host.idleBegan       → bring the checkout's digests current (idle CPU)
//   tests.digestsSettled → next batch, if still idle and none is running
//   a batch ended        → ingest its record, then the next batch
//   host.idleEnded       → cancel the running batch (one batch lost at most)
//
// Each batch is an ordinary `./equin test`, OPPORTUNISTIC
// (`EQUIN_OP_OPPORTUNISTIC`: background lane, low priority, not counted as
// work by the ops blocker — or it would end the idle period it runs in) and
// marked `idle` in its harvest record.

const idleRunLog = defineLogSink({
  id: "tests-idle-runs",
  description:
    "Test-status page: the `./equin test` batches run while the computer is idle.",
});

/** Every batch holds this one lock: at most one runs, and it is what idleEnded cancels. */
const IDLE_LOCK = "idle";
/** Names the batch lock to the by-lock verbs — `lock` ignores the paths. */
const ANY_BATCH = { paths: [IDLE_LOCK] };

// How many batches of THIS idle period already took each file. A file a run
// cannot give a verdict (its record skipped: the tree moved mid-run) keeps its
// status, and would otherwise be picked again and again while idle — so a
// file is taken once, twice only for its confirmation run (`toConfirm`).
// Process memory on purpose: a restart starts a fresh chain, and a new idle
// period a fresh count.
const takenThisIdle = new Map<string, number>();

// Files of main that failed once after passing (`fileTestFailingReports`'s
// `confirm`): the next batch runs them again first, so a failure is believed
// only once a second run on the same code repeats it. Process memory: a
// restart forgets them, and they are judged again on their next run.
const toConfirm = new Set<string>();

export const idleBatchJob = defineSupervisedJob({
  name: "tests.idle-batch",
  description:
    "Runs a small batch of test files whose status on the current code is unknown while the computer is idle, so Debug → Tests fills in without costing anyone time.",
  input: z.object({ paths: z.array(z.string()).min(1) }),
  channel: idleRunLog,
  runAttempts: 1,
  // Failing tests are the page's data (the run's record), never a failed job.
  verdictExits: [TESTS_FAILED_EXIT],
  lock: () => IDLE_LOCK,
  argv: (input) => ({
    argv: [`./${CLI_NAME}`, "test", ...input.paths],
    cwd: REPO_ROOT,
    envOverrides: envEntries({ OP_OPPORTUNISTIC: "1", TEST_ORIGIN: "idle" }),
  }),
  onEnded: async (_runId, _terminal, meta) => {
    // Cancelled: the host stopped being idle — nothing follows.
    if (meta.cancelled) return;
    // Its verdicts must be in the statuses the next selection reads.
    await ingestRunRecordsNow();
    try {
      // A file of main that went from passing to failing (confirmed) is
      // filed; one that failed once is run again first.
      const { confirm } = await fileTestFailingReports(meta.input.paths);
      for (const p of confirm) toConfirm.add(p);
    } finally {
      // A filing error stays loud, but never stops the idle chain.
      await idleNextJob.enqueue({});
    }
  },
});

/** Start the next batch — only while the host is idle and no batch runs. */
export async function startNextIdleBatch(
  now: number = Date.now(),
): Promise<void> {
  if ((await readHostIdleRecord())?.state !== "idle") return;
  if ((await latestSupervisedRun(idleBatchJob, ANY_BATCH))?.open) return;
  const rows = await db
    .select({
      path: _testFileStatus.path,
      status: _testFileStatus.status,
      lastOutcome: _testFileStatus.lastOutcome,
      lastRanAt: _testFileStatus.lastRanAt,
      durationMs: _testFileStatus.durationMs,
    })
    .from(_testFileStatus);
  const confirming = rows.filter(
    (r) => toConfirm.has(r.path) && (takenThisIdle.get(r.path) ?? 0) < 2,
  );
  const paths = selectIdleBatch(
    rows.filter((r) => !takenThisIdle.has(r.path)),
    now,
    confirming,
  );
  if (paths.length === 0) return;
  for (const p of paths) toConfirm.delete(p);
  for (const p of paths) takenThisIdle.set(p, (takenThisIdle.get(p) ?? 0) + 1);
  await idleBatchJob.enqueue({ paths });
}

export const idleNextJob = defineJob({
  name: "tests.idle-next",
  description:
    "Picks the next test files to run while the computer is idle — stale and last failing first, then never run, then the oldest — and starts them.",
  hold: "seconds",
  input: z.object({}),
  event: z.unknown(),
  // One pending pick; never two at once (each would start a batch).
  dedup: "singleton",
  serial: true,
  run: async () => {
    await startNextIdleBatch();
  },
});

export const idleBeganJob = defineJob({
  name: "tests.idle-began",
  description:
    "When the computer becomes idle, brings the test digests up to date with the current code, so the idle test runs pick files by their real status.",
  hold: "seconds",
  input: z.object({}),
  event: z.unknown(),
  dedup: "singleton",
  run: async () => {
    takenThisIdle.clear();
    // Its end (tests.digestsSettled) starts the first batch.
    await requestCheckoutDigests();
  },
});

export const idleEndedJob = defineJob({
  name: "tests.idle-ended",
  description:
    "When the computer stops being idle, stops the idle test run in progress so it never competes with real work.",
  hold: "seconds",
  input: z.object({}),
  event: z.unknown(),
  dedup: "singleton",
  run: async () => {
    await cancelSupervisedJobByLock(idleBatchJob, ANY_BATCH);
  },
});
