import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";

// Per-phase wall-time budgets for the boot-budget monitor. The scheduled monitor
// job reads these live via getConfig each tick, so changes take effect on the
// next run without a restart. Mirrors opRateConfig's per-kind shape (one
// defineConfig with field factories rendered for free in Settings → Config).
//
// Budgets are per boot PHASE because the phases have very different natures — a
// single floor would drown the signal:
//   • onReadyBlocking is the HARD BARRIER before the backend serves (migrations /
//     registry only), so it must stay cheap → tightest budget.
//   • onReady runs CONCURRENT with request serving on the one event-loop thread,
//     so a long span competes with first requests → tight budget.
//   • onAllReady is a post-serving barrier → same tight budget.
//   • warmup is the DECLARED heavy deferred category (defineWarmup, throttled and
//     run after onAllReady), so it legitimately runs longer → loosest budget.
//
// The `name` is a load-bearing literal (persisted config); do not rename.
export const bootBudgetConfig = defineConfig({
  name: "boot-budget",
  fields: {
    enabled: boolField({
      default: true,
      label: "Enabled",
      description:
        "When off, the monitor job returns early and files no boot-budget reports.",
    }),
    onReadyBlockingBudgetMs: intField({
      default: 500,
      min: 0,
      label: "onReadyBlocking budget (ms)",
      description:
        "File a boot-budget report when a plugin's onReadyBlocking hook (the hard barrier before the backend serves) runs longer than this many ms. Keep tight — this phase should be migrations/registry only.",
    }),
    onReadyBudgetMs: intField({
      default: 500,
      min: 0,
      label: "onReady budget (ms)",
      description:
        "File a boot-budget report when a plugin's onReady hook runs longer than this many ms. onReady runs concurrent with request serving on the single event-loop thread, so a long span competes with first requests.",
    }),
    onAllReadyBudgetMs: intField({
      default: 500,
      min: 0,
      label: "onAllReady budget (ms)",
      description:
        "File a boot-budget report when a plugin's onAllReady hook runs longer than this many ms.",
    }),
    warmupBudgetMs: intField({
      default: 2000,
      min: 0,
      label: "Warmup budget (ms)",
      description:
        "File a boot-budget report when a declared warmup span (warmup:<name>) runs longer than this many ms — the default for a warmup that declares no budgetMs of its own (a declared one wins). Looser than the onReady phases because warmups are the declared heavy deferred category, throttled and run after the barrier.",
    }),
  },
});
