import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { ApiErrorRow } from "./components/api-error-row";

export default {
  description:
    "Renders the CLI's own notice of a failed model request in the JSONL viewer — a usage limit with its reset time, a server error, an expired login — as a warning line, not as the agent's words.",
  contributions: [
    JsonlViewer.EventRenderer({ match: "api-error", component: ApiErrorRow }),
  ],
} satisfies PluginDefinition;
