import { z } from "zod";
import { getConfig } from "@plugins/config_v2/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { taskTriageConfig } from "../../shared/config";
import { wakeTriageDispatcher } from "./dispatch";
import {
  failStuckRuns,
  markFailed,
  markOldReadsStale,
  markStaleIfEdited,
  runningTriageOf,
} from "./state";

/** A run that has not submitted after this long is failed by the sweep. */
const STUCK_RUN_MS = 30 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/**
 * A task's title or description was written (`tasks.titleChanged`,
 * `tasks.descriptionChanged` — global, so a task with no read returns at
 * once). Its `done` read goes stale (edited) only when the text now differs
 * from the snapshot the read was made from: the title event also fires on
 * creation and on every Haiku title upgrade, which change nothing it read.
 */
export const triageEditedJob = defineJob({
  name: "task-triage.edited",
  description:
    "Marks a task's triage read stale when the task's title or description is edited after it was read.",
  hold: "instant",
  input: z.object({}),
  event: z.object({ taskId: z.string() }).passthrough(),
  dedup: "none",
  run: async ({ event }) => {
    if (event !== undefined) await markStaleIfEdited(event.taskId);
  },
});

/**
 * A triage run's conversation closed (`done`) while its row was still
 * `running` — it never submitted, and nothing else will fill the read, so the
 * run failed and its slot is free. Bound to every conversation status change
 * (no filter columns), so anything that is not a running triage conversation
 * returns at once. A hibernated (`gone`) conversation is resumable, so it is
 * not a failure.
 */
export const triageConversationStatusJob = defineJob({
  name: "task-triage.conversation-status",
  description:
    "Marks a task triage run failed when its conversation closes before it submitted a read, and frees its slot.",
  hold: "instant",
  input: z.object({}),
  event: z
    .object({ conversationId: z.string(), status: z.string() })
    .passthrough(),
  dedup: "none",
  run: async ({ event }) => {
    if (event?.status !== "done") return;
    const taskId = await runningTriageOf(event.conversationId);
    if (taskId === null) return;
    await markFailed(
      taskId,
      "The conversation was closed before it submitted a read.",
    );
    await wakeTriageDispatcher();
  },
});

/**
 * The passage of time sends no event, so an hourly schedule: reads older than
 * `staleAfterDays` go stale (old), and runs that have not submitted 30 min
 * after they started fail — the backstop for a conversation that died without
 * a status change, so no stuck row holds a `concurrency` slot for good. Then
 * it wakes the dispatcher for whatever that freed.
 */
export const triageSweepJob = defineJob({
  name: "task-triage.sweep",
  description:
    "Marks old task triage reads stale and fails triage runs stuck for 30 minutes, freeing their slots.",
  hold: "instant",
  input: z.object({}).default({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "23 * * * *" },
  run: async () => {
    const now = Date.now();
    const { staleAfterDays } = getConfig(taskTriageConfig);
    await markOldReadsStale(new Date(now - staleAfterDays * DAY_MS));
    const failed = await failStuckRuns(
      new Date(now - STUCK_RUN_MS),
      "The run did not submit a read within 30 minutes.",
    );
    if (failed > 0) await wakeTriageDispatcher();
  },
});
