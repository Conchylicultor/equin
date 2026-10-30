import type { Span } from "@plugins/framework/plugins/server-core/core";
import type { ConfigValues } from "@plugins/config_v2/core";
import type { bootBudgetConfig } from "../../core";

type Budgets = ConfigValues<(typeof bootBudgetConfig)["fields"]>;

// Map a profiler span to its wall-time budget, or null when the span is not a
// monitored boot hook / warmup. Warmups (`warmup:<name>`) are checked FIRST — a
// warmup span may carry any phase (they drain after onAllReady), so its id
// prefix, not its phase, decides its budget. Per-plugin boot-hook spans require
// `span.plugin` set, which cleanly excludes the whole-phase wrapper spans
// (`onReadyBlocking` etc., recorded with no plugin) so we attribute to a specific
// plugin, never the aggregate phase.
//
// A budget the span itself carries (`Span.budgetMs` — a warm-up's declared
// `budgetMs`, stamped by the warm-up executor) wins over the configured default:
// the work said how long it is expected to take.
export function budgetForSpan(
  span: Span,
  cfg: Budgets,
): { budgetMs: number; source: "declared" | "config" } | null {
  if (span.budgetMs !== undefined && isMonitored(span))
    return { budgetMs: span.budgetMs, source: "declared" };
  const budgetMs = configBudget(span, cfg);
  return budgetMs === null ? null : { budgetMs, source: "config" };
}

function isMonitored(span: Span): boolean {
  return span.id.startsWith("warmup:") || span.plugin != null;
}

function configBudget(span: Span, cfg: Budgets): number | null {
  if (span.id.startsWith("warmup:")) return cfg.warmupBudgetMs;
  if (span.plugin == null) return null;
  // An if-chain, not a switch: PhaseId is a growing closed union and we budget
  // only three of its members — switch-exhaustiveness-check would force a case
  // per member (register/migrations/…) that all return null.
  if (span.phase === "onReadyBlocking") return cfg.onReadyBlockingBudgetMs;
  if (span.phase === "onReady") return cfg.onReadyBudgetMs;
  if (span.phase === "onAllReady") return cfg.onAllReadyBudgetMs;
  return null;
}
