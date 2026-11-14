import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  OptimisticDivergencePayloadSchema,
  optimisticDivergenceFingerprint,
} from "../core";
import {
  renderOptimisticDivergenceTask,
  OPTIMISTIC_DIVERGENCE_NOTIF_COOLDOWN_MS,
} from "./internal/optimistic-divergence-task";

export default {
  description:
    "Optimistic-divergence report kind: validates divergence payloads (kind: superseded = dropped for newer server truth, stalled = kept rendered past the miss threshold), fingerprints by kind + resource + label + ops (excluding the volatile miss count), and renders per-kind tasks. Re-arms periodically (6h) since a still-present divergence is a recurring warning, not a one-shot crash.",
  contributions: [
    ReportKind({
      kind: "optimistic-divergence",
      schema: OptimisticDivergencePayloadSchema,
      fingerprint: optimisticDivergenceFingerprint,
      meta: {
        tag: "[optimistic-divergence]",
        notif: "Optimistic op diverged from server truth",
        variant: "warning",
        category: "error",
        notifCooldownMs: OPTIMISTIC_DIVERGENCE_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderOptimisticDivergenceTask,
    }),
  ],
} satisfies ServerPluginDefinition;
