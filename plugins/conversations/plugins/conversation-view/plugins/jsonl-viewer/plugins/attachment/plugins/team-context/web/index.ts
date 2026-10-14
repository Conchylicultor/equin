import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { TeamContextView } from "./components/team-context-view";

export default {
  collapsed: true,
  description:
    "Renders the team_context attachment — the harness telling the agent which teammate it is, and in which session team.",
  contributions: [
    ...attachmentRenderer({
      match: "team_context",
      component: TeamContextView,
      role: "context",
    }),
  ],
} satisfies PluginDefinition;
