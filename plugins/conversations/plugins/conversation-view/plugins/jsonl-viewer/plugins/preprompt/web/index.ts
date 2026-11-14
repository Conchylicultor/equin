import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { PrepromptRow } from "./components/preprompt-row";

export default {
  description:
    "Renders everything equin appended to the agent's system prompt — the launch special instructions (preprompt) and every contributed section (mandate, page instructions, supervisor roles, task tree…) — as one Instructions card in the JSONL viewer, each part folding on its own.",
  contributions: [
    JsonlViewer.EventRenderer({
      match: "preprompt",
      component: PrepromptRow,
    }),
  ],
} satisfies PluginDefinition;
