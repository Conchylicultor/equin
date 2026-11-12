import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { FlagRaiseToolView } from "./components/flag-raise-tool-view";

export default {
  description:
    "Renders flag_raise MCP tool calls with the flagged reason displayed as a warning banner.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: /flag_raise$/,
      icon: symbol("flag"),
      component: FlagRaiseToolView,
    }),
  ],
} satisfies PluginDefinition;
