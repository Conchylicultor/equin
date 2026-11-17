import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import { ReloadLossPayloadSchema, reloadLossFingerprint } from "../core";
import {
  RELOAD_LOSS_NOTIF_COOLDOWN_MS,
  renderReloadLossTask,
} from "./internal/reload-loss-task";

export default {
  description:
    "Reload-loss report kind: validates the payload of a piece of React state a remount threw away (component, which state hook, the first element it renders, the value's shape), fingerprints by origin + component + state index + source line, and renders a task saying how to classify it (kept work, kept view, or useTransient). Re-arms daily.",
  contributions: [
    ReportKind({
      kind: "reload-loss",
      schema: ReloadLossPayloadSchema,
      fingerprint: reloadLossFingerprint,
      meta: {
        tag: "[reload-loss]",
        notif: "A remount threw away state the user changed",
        // `warning`: nothing broke this time; the user loses the state on the
        // next reload or tab unload.
        variant: "warning",
        category: "error",
        notifCooldownMs: RELOAD_LOSS_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderReloadLossTask,
    }),
  ],
} satisfies ServerPluginDefinition;
