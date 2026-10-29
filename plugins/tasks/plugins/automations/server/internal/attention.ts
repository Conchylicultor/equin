import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { getTask } from "@plugins/tasks/plugins/tasks-core/server";
import { TaskStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";
import { automationDetailRoute, type OriginRole } from "../../core";
import { catalogChanged } from "./catalog-changed";
import { catalogStatusMoved } from "./catalog-status";
import { isTaskApproved } from "./decisions";
import { originOfTask } from "./origin";
import { registeredAutomation } from "./registry";

// The statuses in which a task an automation FILED waits on a person: its
// agent asked something, stopped without landing, or was held.
const NEEDS_PERSON = new Set(["need_action", "attempted", "held"]);

// The headline, in the user's words, per waiting status. The automation is
// the subject (line 2); the task's own title is the developer detail.
const STATUS_HEADLINE: Record<string, string> = {
  need_action: "Waiting for you",
  attempted: "Stopped before finishing",
  held: "Held for you",
};

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
 * re-surfaced on every transition that rings (`rings`). A launched task
 * settling is not this job's: the automation's `automations.slot` watcher
 * wakes it (`slot-watch.ts`).
 *
 * It is also how a status change reaches the catalog: `automations.catalog`
 * declares its `tasks_v` read `notified` (never routed through the change
 * feed, whose every write to the tree would recompute it), so this job
 * re-pushes it — only for a transition that moves what it shows
 * (`catalogStatusMoved`: `openTaskId`, `runningTaskIds`, `approvedCount`), of
 * a task it shows: one an automation filed or launched, or one a person
 * approved for launch.
 */
export const automationTaskStatusJob = defineJob({
  name: "automations.task-status",
  description:
    "Notifies you when a task an automation filed or launched needs you, and keeps the Automations list current.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({
      taskId: z.string(),
      status: TaskStatusSchema,
      previousStatus: TaskStatusSchema,
    })
    .passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    const moved = catalogStatusMoved(event.previousStatus, event.status);
    const origin = await originOfTask(event.taskId);
    if (origin === null) {
      // No automation's task — but an approved one waits for a launch, and
      // `approvedCount` counts it only while it is `new`.
      if (moved && (await isTaskApproved(event.taskId))) catalogChanged();
      return;
    }
    const { automationId } = origin;
    if (moved) catalogChanged();
    const automation = registeredAutomation(automationId);
    if (!rings(origin, event.status)) return;

    const task = await getTask(event.taskId);
    if (task === null) return; // deleted since the emit — nothing to look at
    const label = automation?.spec.label ?? automationId;
    // `rings` admits only the statuses STATUS_HEADLINE names.
    const headline = STATUS_HEADLINE[event.status];
    if (headline === undefined) {
      throw new Error(`[automations] no headline for status ${event.status}`);
    }
    await recordNotification({
      type: "automation-task",
      category: "automations",
      icon: automation?.spec.icon ?? null,
      variant: "warning",
      title: headline,
      description: "",
      // The automation is what the user knows; it has no id kind of its own,
      // so the chip carries its name only.
      subjectName: label,
      detail: `${task.title} (${task.id}, ${event.status})`,
      action: { kind: "review-automation", payload: { automationId } },
      linkTo: automationDetailRoute.link(agentManagerApp, { automationId }),
      metadata: { automationId, taskId: task.id, status: event.status },
      dedupeKey: `automation-task:${task.id}`,
      resurfaceAfterMs: 0,
    });
  },
});
