import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { activityLinks } from "@plugins/activity/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { conversationRoute } from "@plugins/conversations/core";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { conversationActivityArm } from "../core";

export default {
  description:
    "The conversation arm's presence in every list of activity: its rows open the conversation in the agent manager; its picked fields wear the entity's labels and options.",
  contributions: [
    FieldPresentation.Register({ owner: conversationActivityArm, fields: {} }),
    activityLinks(conversationActivityArm, (row) =>
      conversationRoute.link(agentManagerApp, { convId: row.id }),
    ),
  ],
} satisfies PluginDefinition;
