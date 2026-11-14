import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  LiveStateStaleDropPayloadSchema,
  liveStateStaleDropFingerprint,
} from "../core";
import {
  renderLiveStateStaleDropTask,
  LIVE_STATE_STALE_DROP_NOTIF_COOLDOWN_MS,
} from "./internal/live-state-stale-drop-task";

export default {
  description:
    "Live-state stale-drop report kind: validates stale-drop payloads (a live-state HTTP body dropped by the version/epoch guard while the query still holds only its placeholder — the 'Close (state unknown)' wedge), fingerprints by key + reason (excluding the volatile params/counts/versions/epochs so one wedge = one row), and renders an investigation task. Re-arms periodically (6h) since a still-wedged resource keeps dropping.",
  contributions: [
    ReportKind({
      kind: "live-state-stale-drop",
      schema: LiveStateStaleDropPayloadSchema,
      fingerprint: liveStateStaleDropFingerprint,
      meta: {
        tag: "[live-state-stale-drop]",
        notif: "Live-state resource wedged on stale HTTP body",
        variant: "warning",
        category: "error",
        notifCooldownMs: LIVE_STATE_STALE_DROP_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderLiveStateStaleDropTask,
    }),
  ],
} satisfies ServerPluginDefinition;
