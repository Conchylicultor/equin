import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import { RenderLoopPayloadSchema, renderLoopFingerprint } from "../core";
import {
  renderRenderLoopTask,
  RENDER_LOOP_NOTIF_COOLDOWN_MS,
} from "./internal/render-loop-task";

export default {
  description:
    "Render-loop report kind: validates render-loop payloads, fingerprints by signature + mutation class, and renders per-loop perf tasks. Re-arms periodically (6h) since a still-present loop is a warning, not a one-shot crash.",
  contributions: [
    ReportKind({
      kind: "render-loop",
      schema: RenderLoopPayloadSchema,
      fingerprint: renderLoopFingerprint,
      meta: {
        tag: "[render-loop]",
        notif: "Render loop detected",
        variant: "warning",
        category: "slow-op",
        notifCooldownMs: RENDER_LOOP_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderRenderLoopTask,
    }),
  ],
} satisfies ServerPluginDefinition;
