import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { getTask } from "@plugins/tasks/plugins/tasks-core/server";
import { TaskStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";
import {
  automationDetailRoute,
  SLOT_SETTLED_STATUSES,
  type OriginRole,
} from "../../core";
import { catalogChanged } from "./catalog-changed";
import { originOfTask } from "./origin";
import { registeredAutomation } from "./registry";

// The statuses in which a task an automation FILED waits on a person: its
// agent asked something, stopped without landing, or was held.
const NEEDS_PERSON = new Set(["need_action", "attempted", "held"]);

const STATUS_WORDS: Record<string, string> = {
  need_action: "is waiting for you",
  attempted: "stopped without landing",
  held: "was held",
};

const SETTLES_SLOT: ReadonlySet<string> = new Set(SLOT_SETTLED_STATUSES);

/**
 * Whether a status change of an automated task is worth the bell.
 *
 * - A FILED task: every transition into a waiting status — each is a new
 *   reason to look.
 * - A LAUNCHED task (a task someone else filed, that a launch-kind automation
 *   only started): only `attempted` while it still holds its slot — its agent
 *   went away without reporting. Its agent leaves the person a report instead
 *   (whose own surface asks for them), so `need_action` — which it passes
 *   through at every turn's end, a build wait included — would only be noise;
 *   `held` was a person's own act; and once released, closing its
 *   conversation is the person reading the report, not news.
 */
function rings(
  origin: { role: OriginRole; releasedAt: Date | null },
  status: string,
): boolean {
  if (origin.role === "filed") return NEEDS_PERSON.has(status);
  return status === "attempted" && origin.releasedAt === null;
}

/**
 * The bell is where an automated task asks for its person: nobody watches the
 * task list for tasks they did not file. One row per task (`dedupeKey`),
 * re-surfaced on every transition that rings (`rings`). Every status change of
 * an automated task also re-pushes the catalog, whose `openTaskId` /
 * `runningTaskIds` follow it, and a launched task settling wakes the
 * automation that launched it, so the next task takes its slot.
 */
export const automationTaskStatusJob = defineJob({
  name: "automations.task-status",
  description:
    "Notifies you when a task an automation filed or launched needs you, starts the next task when one a launch automation started settles, and keeps the Automations list current.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({ taskId: z.string(), status: TaskStatusSchema })
    .passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    const origin = await originOfTask(event.taskId);
    if (origin === null) return;
    const { automationId } = origin;
    catalogChanged();
    const automation = registeredAutomation(automationId);
    if (origin.role === "launched" && SETTLES_SLOT.has(event.status)) {
      automation?.wake();
    }
    if (!rings(origin, event.status)) return;

    const task = await getTask(event.taskId);
    if (task === null) return; // deleted since the emit — nothing to look at
    const label = automation?.spec.label ?? automationId;
    await recordNotification({
      type: "automation-task",
      variant: "warning",
      title: `${label}: task ${STATUS_WORDS[event.status]}`,
      description: task.title,
      linkTo: automationDetailRoute.link(agentManagerApp, { automationId }),
      metadata: { automationId, taskId: task.id, status: event.status },
      dedupeKey: `automation-task:${task.id}`,
      resurfaceAfterMs: 0,
    });
  },
});
