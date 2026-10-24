import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { getTask } from "@plugins/tasks/plugins/tasks-core/server";
import { decideLaunchEndpoint, taskApprovalEndpoint } from "../../core";
import { decideLaunch, setTaskApproval } from "./decisions";
import { catalogChanged } from "./catalog-changed";
import { registeredAutomation, registeredAutomations } from "./registry";

/**
 * A person's include / exclude / clear on tasks, from a launch-kind
 * automation's list. The decision is the task's (`:automationId` is not
 * stored); the automation is woken: an approval may fill a free slot now.
 */
export const handleDecideLaunch = implement(
  decideLaunchEndpoint,
  async ({ params, body }) => {
    const registered = registeredAutomation(params.automationId);
    if (registered === undefined) {
      throw new HttpError(404, `No automation "${params.automationId}".`);
    }
    if (registered.spec.kind !== "launch") {
      throw new HttpError(
        400,
        `Automation "${params.automationId}" files its own tasks; it launches nothing a person approves.`,
      );
    }
    await decideLaunch(body.taskIds, body.decision);
    catalogChanged();
    if (body.decision === "approved") registered.wake();
  },
);

/**
 * A person approves one task, or takes the approval back, from the task
 * itself. An approval wakes every launch-kind automation: whichever counts the
 * task among its candidates may launch it into a free slot now.
 */
export const handleTaskApproval = implement(
  taskApprovalEndpoint,
  async ({ params, body }) => {
    if ((await getTask(params.taskId)) === null) {
      throw new HttpError(404, `No task "${params.taskId}".`);
    }
    await setTaskApproval(params.taskId, body.approved);
    catalogChanged();
    if (!body.approved) return;
    for (const registered of registeredAutomations()) {
      if (registered.spec.kind === "launch") registered.wake();
    }
  },
);
