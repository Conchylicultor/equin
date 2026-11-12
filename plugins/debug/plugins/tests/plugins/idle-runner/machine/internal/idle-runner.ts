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

// The files a batch of THIS idle period already took. A file a run cannot
// give a verdict (its record skipped: the tree moved mid-run) keeps its
// status, and would otherwise be picked again and again while idle. Process
// memory on purpose: a restart starts a fresh chain, and a new idle period a
// fresh set.
const triedThisIdle = new Set<string>();

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
    await idleNextJob.enqueue({});
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
  const paths = selectIdleBatch(
    rows.filter((r) => !triedThisIdle.has(r.path)),
    now,
  );
  if (paths.length === 0) return;
  for (const p of paths) triedThisIdle.add(p);
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
    triedThisIdle.clear();
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
