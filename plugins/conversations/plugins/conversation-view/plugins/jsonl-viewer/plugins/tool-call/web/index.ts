import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { JsonlRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { JsonlViewerToolSlots } from "./slots";
import { ToolCallRow } from "./components/tool-call-row";
import { CopyToolResultAction } from "./components/copy-result-action";

export { JsonlViewerTool } from "./slots";
export type {
  PartialToolRendererSpec,
  ToolFooterContribution,
  ToolFooterProps,
  ToolIcon,
  ToolRendererSpec,
} from "./slots";
export { ToolCallCard, ToolCallFrame } from "./components/tool-call-card";
export {
  toolInputDriftSink,
  type ToolInputDrift,
} from "./internal/input-drift";
export { ToolNameLabel } from "./components/tool-name-label";
export {
  ToolCode,
  ToolCodeEmpty,
  ToolOutput,
  ToolSection,
  toolResultStatus,
  type ToolSectionStatus,
} from "./components/tool-section";

export default {
  collapsed: true,
  description:
    "Renders paired tool-call events with exact/pattern/fallback dispatch to per-tool renderer plugins.",
  contributions: [
    JsonlViewer.EventRenderer({
      match: "tool-call",
      component: ToolCallRow,
      // A call streams in as its stand-in while the model writes it.
      landsShown: true,
    }),
    JsonlRowActions.Item({
      id: "copy-tool-result",
      component: CopyToolResultAction,
    }),
  ],
  slots: JsonlViewerToolSlots,
} satisfies PluginDefinition;
