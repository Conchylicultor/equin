import type { Span } from "@plugins/framework/plugins/server-core/core";
import type { ConfigValues } from "@plugins/config_v2/core";
import type { bootBudgetConfig } from "../../core";

type Budgets = ConfigValues<(typeof bootBudgetConfig)["fields"]>;

// Map a profiler span to its wall-time budget, or null when the span is not a
// monitored boot hook. Per-plugin boot-hook spans require `span.plugin` set,
// which cleanly excludes the whole-phase wrapper spans (`onReadyBlocking` etc.,
// recorded with no plugin) so we attribute to a specific plugin, never the
// aggregate phase.
//
// Warm-ups (`warmup:<name>`) are NOT judged here: a warm-up is judged once, by
// slow-ops, on its `bg` span (its own time, against its declared budget or the
// warm-up default) — judging the same run here too filed it twice
// (research/2026-10-30-global-slow-op-one-cause-one-report.md). Their boot
// spans stay for the boot Gantt.
export function budgetForSpan(span: Span, cfg: Budgets): number | null {
  if (span.plugin == null) return null;
  // An if-chain, not a switch: PhaseId is a growing closed union and we budget
  // only three of its members — switch-exhaustiveness-check would force a case
  // per member (register/migrations/…) that all return null.
  if (span.phase === "onReadyBlocking") return cfg.onReadyBlockingBudgetMs;
  if (span.phase === "onReady") return cfg.onReadyBudgetMs;
  if (span.phase === "onAllReady") return cfg.onAllReadyBudgetMs;
  return null;
}
