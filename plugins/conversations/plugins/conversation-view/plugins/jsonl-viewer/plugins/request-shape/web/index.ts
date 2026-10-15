import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { RequestShapeRow } from "./components/request-shape-row";

export default {
  description:
    "Renders the system prompt and tool set Claude Code logs for model calls (api-request-shape): the agent's tools and prompt on first use, then one row per change — a deferred tool loaded, a tool dropped, the prompt edited.",
  contributions: [
    JsonlViewer.EventRenderer({
      match: "request-shape",
      component: RequestShapeRow,
    }),
  ],
} satisfies PluginDefinition;
