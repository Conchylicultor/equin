import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  OptimisticRejectionPayloadSchema,
  optimisticRejectionFingerprint,
} from "../core";
import {
  renderOptimisticRejectionTask,
  OPTIMISTIC_REJECTION_NOTIF_COOLDOWN_MS,
} from "./internal/optimistic-rejection-task";

export default {
  description:
    "Optimistic-rejection report kind: validates rejected-write payloads (a write the server permanently refused, so the user's edit was lost), fingerprints by resource + label + status + op + normalized reason (excluding params), and renders the investigation task. Re-arms periodically (6h): a rejection recurs on every edit of the same shape.",
  contributions: [
    ReportKind({
      kind: "optimistic-rejection",
      schema: OptimisticRejectionPayloadSchema,
      fingerprint: optimisticRejectionFingerprint,
      meta: {
        tag: "[optimistic-rejection]",
        notif: "The server rejected an edit",
        variant: "error",
        category: "error",
        notifCooldownMs: OPTIMISTIC_REJECTION_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderOptimisticRejectionTask,
    }),
  ],
} satisfies ServerPluginDefinition;
