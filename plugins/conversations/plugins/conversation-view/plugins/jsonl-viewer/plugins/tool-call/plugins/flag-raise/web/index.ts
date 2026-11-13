import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import {
  FlagRaiseInputSchema,
  FlagRaiseToolView,
} from "./components/flag-raise-tool-view";

export default {
  description:
    "Renders flag_raise MCP tool calls as a warning banner: the items the user must act on, and the details folded under them (or, for a flag raised before the split, its one reason).",
  contributions: [
    JsonlViewerTool.Renderer({
      match: /flag_raise$/,
      icon: symbol("flag"),
      input: FlagRaiseInputSchema,
      component: FlagRaiseToolView,
    }),
  ],
} satisfies PluginDefinition;
