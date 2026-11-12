import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { WorkflowToolView } from "./components/workflow-tool-view";
import { workflowNodePane } from "./panes";
import { WorkflowInputSchema } from "./internal/workflow-input";
import { WORKFLOW_TOOL_NAME } from "../core";

export default {
  description:
    "Renders Workflow tool calls as a swimlane DAG of agent nodes (recovered by trace-executing the script), with per-node prompts in a side pane, a collapsible script, and the launched run/task ids.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: WORKFLOW_TOOL_NAME,
      icon: symbol("account-tree"),
      input: WorkflowInputSchema,
      component: WorkflowToolView,
    }),
    Pane.Register({ pane: workflowNodePane }),
  ],
  slots: { "workflow-node": workflowNodePane },
} satisfies PluginDefinition;
