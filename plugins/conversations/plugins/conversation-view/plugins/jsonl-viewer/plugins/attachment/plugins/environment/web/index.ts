import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { EnvironmentView } from "./components/environment-view";

export default {
  collapsed: true,
  description:
    "Renders the environment attachment — where the agent is running — as either the opening snapshot or, when the harness reports changes, the fields that moved with their from → to values.",
  contributions: [
    ...attachmentRenderer({
      match: "environment",
      component: EnvironmentView,
      role: "context",
    }),
  ],
} satisfies PluginDefinition;
