import { z } from "zod";
import { getConfig } from "@plugins/config_v2/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { listSidequestTasks } from "@plugins/tasks/plugins/task-track/server";
import { sidequestAutopilotConfig } from "../../shared/config";
import { tasksSidequestTriage } from "./tables";
import { triageSidequest } from "./triage";

// The most ready sidequests one backfill reads (the backlog is tens today).
const BACKFILL_WINDOW = 500;

/**
 * Read one sidequest with read-only Sonnet. Keyed on the task (a pending row
 * collapses repeats) and `serial`, so a backfill of the whole backlog is one
 * model run at a time.
 */
export const triageJob = defineJob({
  name: "sidequest-autopilot.triage",
  description:
    "Reads one sidequest with read-only Sonnet and records what it is, how risky and how big — the context the launch list shows. It approves nothing.",
  hold: "minutes",
  inProcess:
    "One read-only `claude --print` (Read / Grep / Glob over the main checkout), capped at 10 min, serial so at most one runs; it writes its row only once it has answered, so a restart re-runs it from scratch with nothing half-written.",
  input: z.object({ taskId: z.string(), force: z.boolean() }),
  event: z.never(),
  dedup: { key: ({ taskId }) => taskId },
  serial: true,
  maxAttempts: 2,
  slowThresholdMs: 10 * 60_000,
  run: async ({ input }) => {
    await triageSidequest(input.taskId, { force: input.force });
  },
});

/**
 * Queue a triage read of `taskId` unless it was read already — main only,
 * while triage is on. The job re-checks everything when it runs.
 */
export async function requestTriage(taskId: string): Promise<void> {
  if (!isMain() || !getConfig(sidequestAutopilotConfig).triage) return;
  if ((await tasksSidequestTriage.get(taskId)) !== undefined) return;
  await triageJob.enqueue({ taskId, force: false });
}

/**
 * A task may have become a ready sidequest — it became one (`tasks.trackChanged`
 * to sidequest) or a sidequest became ready (`tasks.statusChanged` to new).
 * Queues its triage read if it has none.
 */
export const triageOnTaskJob = defineJob({
  name: "sidequest-autopilot.triage-on-task",
  description:
    "Queues a triage read for a sidequest that became ready and has none yet.",
  hold: "instant",
  input: z.object({}),
  event: z.object({ taskId: z.string() }).passthrough(),
  dedup: "none",
  run: async ({ event }) => {
    if (event !== undefined) await requestTriage(event.taskId);
  },
});

/**
 * Queues a read of every ready sidequest without one — the backlog before
 * triage existed, and whatever became ready while no backend ran.
 */
export const triageBackfillJob = defineJob({
  name: "sidequest-autopilot.triage-backfill",
  description:
    "Queues a triage read for every ready sidequest that has none yet.",
  hold: "instant",
  input: z.object({}).default({}),
  event: z.never(),
  dedup: "singleton",
  run: async () => {
    const tasks = await listSidequestTasks({
      statuses: ["new"],
      limit: BACKFILL_WINDOW,
    });
    for (const task of tasks) await requestTriage(task.id);
  },
});

// A declared warm-up rather than an `onReady` enqueue: deferred past
// serving-ready and throttled. Main only, like every automation run — a
// worktree's sidequests are main's, forked.
export const triageBackfillWarmup = defineWarmup({
  name: "sidequest-autopilot.triage-backfill",
  description:
    "Queues triage reads at startup for ready sidequests that have none.",
  scope: "host",
  run: async () => {
    if (!isMain()) return;
    await triageBackfillJob.enqueue({});
  },
});

// Process state: whether triage was on at the last look, so turning it on
// (not every config write) queues the backfill.
let triageWasOn: boolean | null = null;

/**
 * Turned on, triage reads whatever the backlog holds unread. Call at boot and
 * on every config change; only an off → on edge queues the backfill (boot is
 * the warm-up's).
 */
export function backfillWhenTriageTurnsOn(): void {
  const on = getConfig(sidequestAutopilotConfig).triage;
  if (on && triageWasOn === false && isMain()) {
    void triageBackfillJob.enqueue({});
  }
  triageWasOn = on;
}
