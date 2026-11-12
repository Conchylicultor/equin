import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { BashToolView } from "./components/bash-tool-view";

export default {
  description:
    "Renders Bash tool calls with a syntax-highlighted command, optional description label, and ANSI-stripped output.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: "Bash",
      icon: symbol("terminal"),
      component: BashToolView,
    }),
  ],
} satisfies PluginDefinition;
