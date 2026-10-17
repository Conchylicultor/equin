import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import { PanelOverflowPayloadSchema, panelOverflowFingerprint } from "../core";
import {
  renderPanelOverflowTask,
  PANEL_OVERFLOW_NOTIF_COOLDOWN_MS,
} from "./internal/panel-overflow-task";

export default {
  description:
    "Panel-overflow report kind: validates the control-panel overflow guard's fault payloads (a popover panel whose showing page is wider than the panel, because its content needs a width bucket nothing on the page declared), fingerprints by panel label + page (excluding widths, which vary with theme and viewport), and renders a task naming the overflowing element and the `needs` declaration to add. Re-arms periodically (6h) since the page overflows on every open.",
  contributions: [
    ReportKind({
      kind: "panel-overflow",
      schema: PanelOverflowPayloadSchema,
      fingerprint: panelOverflowFingerprint,
      meta: {
        tag: "[panel-overflow]",
        notif: "A control panel's content is wider than the panel",
        // `warning`: the panel is still usable, just cut off at its edge.
        variant: "warning",
        notifCooldownMs: PANEL_OVERFLOW_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderPanelOverflowTask,
    }),
  ],
} satisfies ServerPluginDefinition;
