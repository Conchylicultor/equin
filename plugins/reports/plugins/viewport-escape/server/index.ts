import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  ViewportEscapePayloadSchema,
  viewportEscapeFingerprint,
} from "../core";
import {
  renderViewportEscapeTask,
  VIEWPORT_ESCAPE_NOTIF_COOLDOWN_MS,
} from "./internal/viewport-escape-task";

export default {
  description:
    "Viewport-escape report kind: validates the viewport-overlay auditor's fault payloads (viewport-containing-block = an ancestor's transform/filter/contain made itself the frame of reference, so the box is clipped instead of full-viewport; viewport-stacking-context = an ancestor opened a stacking context, so the box's z-index is compared in the wrong bracket and it stops covering the chrome beside it), fingerprints by fault + subject + blocking element (excluding the message, whose quoted computed value changes every scroll), and renders a per-fault task naming the declaration to remove, scope or make conditional. Re-arms periodically (6h) since the offending declaration reproduces the fault on every activation.",
  contributions: [
    ReportKind({
      kind: "viewport-escape",
      schema: ViewportEscapePayloadSchema,
      fingerprint: viewportEscapeFingerprint,
      meta: {
        tag: "[viewport-escape]",
        notif: "A viewport-filling box cannot reach the viewport",
        // `warning`, not `error`: both faults leave a usable app — an imperfect
        // fullscreen is still a fullscreen. What is wrong is a CSS declaration
        // in another plugin, and that wants fixing rather than alarming.
        variant: "warning",
        category: "error",
        notifCooldownMs: VIEWPORT_ESCAPE_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderViewportEscapeTask,
    }),
  ],
} satisfies ServerPluginDefinition;
