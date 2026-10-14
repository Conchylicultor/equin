import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { SystemRow } from "./components/system-row";
import { informationalSystemRole } from "./context-role";

export default {
  description:
    "Renders system events in the JSONL viewer; an informational notice folds with the harness context around it.",
  contributions: [
    JsonlViewer.EventRenderer({ match: "system", component: SystemRow }),
    JsonlViewer.ContextRole({
      id: "system:informational",
      role: informationalSystemRole,
    }),
  ],
} satisfies PluginDefinition;
