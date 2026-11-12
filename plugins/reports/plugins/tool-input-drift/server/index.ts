import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  ToolInputDriftPayloadSchema,
  toolInputDriftFingerprint,
} from "../core";
import {
  renderToolInputDriftTask,
  TOOL_INPUT_DRIFT_NOTIF_COOLDOWN_MS,
} from "./internal/tool-input-drift-task";

export default {
  description:
    "Tool-input-drift report kind: validates the drift a transcript tool card saw (its tool took an input the card's schema rejects), fingerprints by tool + issues, and renders a task naming the renderer schema to fix. Re-arms daily.",
  contributions: [
    ReportKind({
      kind: "tool-input-drift",
      schema: ToolInputDriftPayloadSchema,
      fingerprint: toolInputDriftFingerprint,
      meta: {
        tag: "[tool-input-drift]",
        notif: "A tool card's schema rejects an input its tool took",
        // `warning`: the generic card still draws the call.
        variant: "warning",
        notifCooldownMs: TOOL_INPUT_DRIFT_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderToolInputDriftTask,
    }),
  ],
} satisfies ServerPluginDefinition;
