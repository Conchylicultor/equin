import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";

// The whole-boot budget for the boot monitor. The scheduled monitor job reads
// this live via getConfig each tick, so changes take effect on the next run
// without a restart (mirrors boot-budget's shape). Distinct from boot-budget's
// per-PHASE budgets on purpose: boot-budget answers "which hook is heavy"
// (one report per over-budget span); this monitor answers "was THIS boot slow
// as a whole" (one slow-op row + coherent trace per over-budget boot).
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
    totalBootBudgetMs: intField({
      default: 10_000,
      min: 0,
      label: "Total boot budget (ms)",
      description:
        "Mint a 'boot' slow-op + trace when a server boot's total profiled duration (through the settled phase) exceeds this many ms. Within-budget boots mint nothing — Debug → Boot Profile stays the always-on deep-dive.",
    }),
  },
});
