import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { AddTaskToolView } from "./components/add-task-tool-view";

export default {
  description:
    "Renders add_task MCP tool calls with task title, description, and a clickable chip to open the created task.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: /add_task$/,
      icon: symbol("check-box"),
      component: AddTaskToolView,
    }),
  ],
} satisfies PluginDefinition;
