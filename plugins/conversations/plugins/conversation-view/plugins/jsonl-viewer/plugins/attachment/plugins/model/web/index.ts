import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { ModelView } from "./components/model-view";

export default {
  collapsed: true,
  description:
    "Renders the model attachment — which model the harness put behind the session — as a one-line row naming the model, its exact id, and its knowledge cutoff.",
  contributions: [
    ...attachmentRenderer({
      match: "model",
      component: ModelView,
      role: "context",
    }),
  ],
} satisfies PluginDefinition;
