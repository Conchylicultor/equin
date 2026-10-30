import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";

// The time-to-ready budget for the boot monitor. The scheduled monitor job
// reads this live via getConfig each tick, so changes take effect on the next
// run without a restart (mirrors boot-budget's shape). Distinct from
// boot-budget's per-PHASE budgets on purpose: boot-budget answers "which hook
// is heavy" (one report per over-budget span); this monitor answers "did THIS
// boot take too long to become ready" (one slow-op row + coherent trace per
// over-budget boot). Post-ready work — the settled phase's warm-up drain — is
// not judged here: each warm-up is judged against its own declared budget.
//
// The `name` is a load-bearing literal (persisted config); do not rename.
export const bootMonitorConfig = defineConfig({
  name: "boot-monitor",
  fields: {
    enabled: boolField({
      default: true,
      label: "Enabled",
      description:
        "When off, the monitor job returns early and mints no boot slow-ops or traces.",
    }),
    readyBudgetMs: intField({
      default: 10_000,
      min: 0,
      label: "Time-to-ready budget (ms)",
      description:
        "Mint a 'boot' slow-op + trace when a server takes longer than this many ms from process start to ready (the onReadyBlocking barrier done — what the gateway waits on before switching to it). Post-ready warm-ups are judged by their own budgets. Within-budget boots mint nothing — Debug → Boot Profile stays the always-on deep-dive.",
    }),
  },
});
