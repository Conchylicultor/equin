import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import { AdaptiveBarPayloadSchema, adaptiveBarFingerprint } from "../core";
import {
  renderAdaptiveBarTask,
  ADAPTIVE_BAR_NOTIF_COOLDOWN_MS,
} from "./internal/adaptive-bar-task";

export default {
  description:
    "Adaptive-bar report kind: validates the adaptive-bar primitive's layout-contract fault payloads (no-slack = the bar was given no room to give, nested-bar = a measuring bar was written inside another bar's occupant so both claim the same row's slack, row-overflow = on a converged pass the fit blessed the row as fitting and the occupants still stick out of the bar's own content box, no-convergence = the placement never settled, iframe-relocation = a frame the browser cannot move without reloading, empty-rung = a widget declared a smaller form and rendered nothing as it), fingerprints by fault + origin (the innermost UI-context node above the bar's root, falling back to the label that several unrelated bars share) + overflow mode + the offending occupant's id, excluding the per-occurrence lineage path, round evidence and message so one broken bar = one row, and renders a per-fault task — what the bar did instead, the consumer-side fix, and for no-convergence the recorded rounds naming which occupant resized itself. Re-arms periodically (6h) since a broken host re-produces the fault on every mount.",
  contributions: [
    ReportKind({
      kind: "adaptive-bar",
      schema: AdaptiveBarPayloadSchema,
      fingerprint: adaptiveBarFingerprint,
      meta: {
        tag: "[adaptive-bar]",
        notif: "Adaptive bar layout contract violated",
        // `warning`, not `error`: every fault path leaves a usable surface —
        // the bar either carries on, or takes the floor layout (cramped, not
        // broken). What is wrong is the host's layout contract, and that wants
        // fixing rather than alarming.
        variant: "warning",
        category: "error",
        notifCooldownMs: ADAPTIVE_BAR_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderAdaptiveBarTask,
    }),
  ],
} satisfies ServerPluginDefinition;
