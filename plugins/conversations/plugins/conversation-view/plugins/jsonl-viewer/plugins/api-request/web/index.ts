import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { apiRequestRole } from "./context-role";
import { ApiRequestRow } from "./components/api-request-row";

export default {
  description:
    "Renders the model API call settings Claude Code logs (model, effort, thinking, max tokens, permission mode, betas, tool set) as a change log: the first call's settings, then one row per call that changed them. Folds with the harness context around it.",
  contributions: [
    JsonlViewer.EventRenderer({
      match: "api-request",
      component: ApiRequestRow,
    }),
    JsonlViewer.ContextRole({ id: "api-request", role: apiRequestRole }),
  ],
} satisfies PluginDefinition;
