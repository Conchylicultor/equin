import { z } from "zod";
import { useAppLink } from "@plugins/apps-core/plugins/tabs/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import type { NotificationActionKind } from "@plugins/shell/plugins/notifications/web";
import { automationDetailRoute } from "../../core";

const ReviewPayloadSchema = z.object({ automationId: z.string() });

/**
 * `review-automation`: an automation's task waits on its person — open the
 * automation (`payload: { automationId }`), where its waiting tasks are.
 */
export const reviewAutomationAction: NotificationActionKind = {
  kind: "review-automation",
  label: "Review",
  useLink: function useReviewAutomation() {
    const appLink = useAppLink();
    return (payload) =>
      appLink(
        automationDetailRoute.link(agentManagerApp, {
          automationId: ReviewPayloadSchema.parse(payload).automationId,
        }),
      );
  },
};
