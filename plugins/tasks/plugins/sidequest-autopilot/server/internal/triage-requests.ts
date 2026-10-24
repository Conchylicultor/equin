import { z } from "zod";
import { getConfig } from "@plugins/config_v2/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  getTaskTrack,
  listSidequestTasks,
} from "@plugins/tasks/plugins/task-track/server";
import { requestTriage } from "@plugins/tasks/plugins/task-triage/server";
import { sidequestAutopilotConfig } from "../../shared/config";

// The most ready sidequests one backfill asks for (the backlog is tens today).
const BACKFILL_WINDOW = 500;

/**
 * Ask task-triage for a read of `taskId` unless it has one already — main
 * only, while the autopilot's `triage` toggle is on. task-triage queues it and
 * runs it `concurrency` at a time; a task already triaged (or in flight) is
 * left alone (`force: false`).
 */
async function requestSidequestTriage(taskId: string): Promise<void> {
  if (!isMain() || !getConfig(sidequestAutopilotConfig).triage) return;
  await requestTriage(taskId, { force: false });
}

/**
 * A task may have become a ready sidequest — it became one (`tasks.trackChanged`
 * to sidequest) or a sidequest became ready (`tasks.statusChanged` to new).
 * Asks for its triage if it has none. The status event fires for every task
 * (each one is created `new`), so a task on the main track is skipped here: a
 * task filed as a sidequest is caught by its own `trackChanged`.
 */
export const triageOnTaskJob = defineJob({
  name: "sidequest-autopilot.triage-on-task",
  description:
    "Asks task-triage for a read of a sidequest that became ready and has none yet.",
  hold: "instant",
  input: z.object({}),
  event: z.object({ taskId: z.string() }).passthrough(),
  dedup: "none",
  run: async ({ event }) => {
    if (event === undefined) return;
    if ((await getTaskTrack(event.taskId)) !== "sidequest") return;
    await requestSidequestTriage(event.taskId);
  },
});

/**
 * Asks for a read of every ready sidequest without one — the backlog before
 * triage was on, and whatever became ready while no backend ran.
 */
export const triageBackfillJob = defineJob({
  name: "sidequest-autopilot.triage-backfill",
  description:
    "Asks task-triage for a read of every ready sidequest that has none yet.",
  hold: "instant",
  input: z.object({}).default({}),
  event: z.never(),
  dedup: "singleton",
  run: async () => {
    const tasks = await listSidequestTasks({
      statuses: ["new"],
      limit: BACKFILL_WINDOW,
    });
    for (const task of tasks) await requestSidequestTriage(task.id);
  },
});

// A declared warm-up rather than an `onReady` enqueue: deferred past
// serving-ready and throttled. Main only, like every automation run — a
// worktree's sidequests are main's, forked.
export const triageBackfillWarmup = defineWarmup({
  name: "sidequest-autopilot.triage-backfill",
  description:
    "Asks at startup for triage reads of ready sidequests that have none.",
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
