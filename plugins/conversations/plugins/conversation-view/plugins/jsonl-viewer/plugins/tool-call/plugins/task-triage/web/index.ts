import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { TriageResultSchema } from "@plugins/tasks/plugins/task-triage/core";
import {
  PartialTriageInputSchema,
  TaskSubmitTriageToolView,
} from "./components/task-submit-triage-tool-view";

export default {
  description:
    "Renders task_submit_triage MCP tool calls: the verdict, priority, type and risk as chips in the header, the context as markdown, and the question with its one-click answers.",
  contributions: [
    // The finished input is the tool's own schema; every field is optional
    // while the input streams in.
    JsonlViewerTool.Renderer({
      match: /task_submit_triage$/,
      icon: symbol("article"),
      input: TriageResultSchema,
      partialInput: PartialTriageInputSchema,
      component: TaskSubmitTriageToolView,
    }),
  ],
} satisfies PluginDefinition;
