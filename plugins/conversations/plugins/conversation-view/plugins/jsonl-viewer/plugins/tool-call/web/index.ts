import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { JsonlRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { JsonlViewerTool as JsonlViewerToolSlots } from "./slots";
import { ToolCallRow } from "./components/tool-call-row";
import { CopyToolResultAction } from "./components/copy-result-action";

export { JsonlViewerTool } from "./slots";
export type {
  ToolFooterContribution,
  ToolFooterProps,
  ToolRendererContribution,
} from "./slots";
export { ToolCallCard, ToolCallFrame } from "./components/tool-call-card";
export { ToolNameLabel } from "./components/tool-name-label";

export default {
  collapsed: true,
  description:
    "Renders paired tool-call events with exact/pattern/fallback dispatch to per-tool renderer plugins.",
  contributions: [
    JsonlViewer.EventRenderer({ match: "tool-call", component: ToolCallRow }),
    JsonlRowActions.Item({
      id: "copy-tool-result",
      component: CopyToolResultAction,
    }),
  ],
  slots: JsonlViewerToolSlots,
} satisfies PluginDefinition;
