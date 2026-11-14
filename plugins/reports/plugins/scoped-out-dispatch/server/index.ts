import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  ScopedOutDispatchPayloadSchema,
  scopedOutDispatchFingerprint,
} from "../core";
import {
  renderScopedOutDispatchTask,
  SCOPED_OUT_DISPATCH_NOTIF_COOLDOWN_MS,
} from "./internal/scoped-out-dispatch-task";

export default {
  description:
    "Scoped-out-dispatch report kind: validates slot-render's fault for a dispatch slot that rendered its fallback inside a PluginScope though the page holds a matching contribution the scope's composition neither bundles nor negates, fingerprints by scope + slot + plugin, and renders a task naming them. Re-arms daily.",
  contributions: [
    ReportKind({
      kind: "scoped-out-dispatch",
      schema: ScopedOutDispatchPayloadSchema,
      fingerprint: scopedOutDispatchFingerprint,
      meta: {
        tag: "[scoped-out-dispatch]",
        notif: "A scoped page fell back for a renderer it left out",
        // `warning`: the fallback still renders.
        variant: "warning",
        category: "error",
        notifCooldownMs: SCOPED_OUT_DISPATCH_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderScopedOutDispatchTask,
    }),
  ],
} satisfies ServerPluginDefinition;
