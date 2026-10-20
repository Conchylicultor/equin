import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { decideLaunchEndpoint } from "../../core";
import { decideLaunch } from "./decisions";
import { catalogChanged } from "./catalog-changed";
import { registeredAutomation } from "./registry";

/**
 * A person's include / exclude / clear on tasks for a launch-kind automation.
 * Wakes it: an approval may fill a free slot now.
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
    await decideLaunch(registered.spec.id, body.taskIds, body.decision);
    catalogChanged();
    if (body.decision === "approved") registered.wake();
  },
);
