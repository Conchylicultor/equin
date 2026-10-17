import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { activityLinks } from "@plugins/activity/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { taskDetailRoute } from "@plugins/tasks/plugins/tasks-core/core";
import { taskActivityArm } from "../core";

export default {
  description:
    "The task arm's presence in every list of activity: its rows open the task's detail pane in the agent manager. Its band's fields are its entity's exposures, presented by their own plugins.",
  contributions: [
    FieldPresentation.Register({ owner: taskActivityArm, fields: {} }),
    activityLinks(taskActivityArm, (row) =>
      taskDetailRoute.link(agentManagerApp, { taskId: row.id }),
    ),
  ],
} satisfies PluginDefinition;
