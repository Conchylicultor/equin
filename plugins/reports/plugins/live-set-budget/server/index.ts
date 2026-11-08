import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  LIVE_SET_OVER_BUDGET_KIND,
  LiveSetOverBudgetPayloadSchema,
  liveSetOverBudgetFingerprint,
} from "../core";
import { overBudgetHandler } from "./internal/over-budget-handler";
import {
  LIVE_SET_OVER_BUDGET_NOTIF_COOLDOWN_MS,
  renderOverBudgetTask,
} from "./internal/over-budget-task";

export default {
  description:
    "Live-set-over-budget report kind: drains network/live's liveSetOverBudgetSink — a whole set declared `all: { unbounded: { reason, budget } }` that loaded more rows than its budget — into one deduped report per key (debounced 10 min), so a wrong `unbounded` reason surfaces long before the set costs every tab megabytes. Renders an investigation task naming the key, the rows, the budget and the reason.",
  contributions: [
    ReportKind({
      kind: LIVE_SET_OVER_BUDGET_KIND,
      schema: LiveSetOverBudgetPayloadSchema,
      fingerprint: liveSetOverBudgetFingerprint,
      meta: {
        tag: "[live-set]",
        notif: "A live set outgrew its budget",
        variant: "warning",
        notifCooldownMs: LIVE_SET_OVER_BUDGET_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderOverBudgetTask,
    }),
  ],
  sinkHandlers: [overBudgetHandler],
} satisfies ServerPluginDefinition;
