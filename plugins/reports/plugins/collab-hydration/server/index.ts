import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import { CollabHydrationPayloadSchema, collabHydrationFingerprint } from "../core";
import {
  renderCollabHydrationTask,
  COLLAB_HYDRATION_NOTIF_COOLDOWN_MS,
} from "./internal/collab-hydration-task";

export default {
  description:
    "Collab-hydration report kind: validates the page editor's hydration-guard payloads (a block whose rendered text stopped agreeing with its content doc, or whose doc fell behind the server), fingerprints by reason alone (the block id and the three lengths are per-occurrence noise), and renders an investigation task.",
  contributions: [
    ReportKind({
      kind: "collab-hydration",
      schema: CollabHydrationPayloadSchema,
      fingerprint: collabHydrationFingerprint,
      meta: {
        tag: "[collab-hydration]",
        notif: "A block's text stopped rendering",
        variant: "warning",
        category: "error",
        notifCooldownMs: COLLAB_HYDRATION_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderCollabHydrationTask,
    }),
  ],
} satisfies ServerPluginDefinition;
