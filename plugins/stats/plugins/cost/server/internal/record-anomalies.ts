import { recordReport } from "@plugins/reports/plugins/engine/server";
import type { ArchiveShrink } from "./archive";
import type { UnpricedModel } from "./usage-index";

/**
 * File the two anomaly kinds the capture path found. Called ONLY from
 * `captureCostHistory` (boot warm-up + daily job), never per request — the
 * conditions are steady-state, so reporting them on every read would be a DB
 * upsert per model per chart request for a fact that has not changed.
 *
 * Both kinds dedup on a fingerprint, so repeats collapse onto one row whose
 * `count` grows.
 */
export async function reportCostAnomalies(
  unpriced: UnpricedModel[],
  shrunk: ArchiveShrink[],
): Promise<void> {
  for (const m of unpriced) {
    // The `<synthetic>` pseudo-model appears ~81 times across the corpus with
    // EXACTLY zero tokens on every entry — it is Claude Code's placeholder for a
    // response that consumed nothing. It resolves to no price and never will, so
    // reporting it would be pure recurring noise. A zero-token bucket also costs
    // $0 under any price, so nothing is under-reported by staying quiet.
    if (m.tokens <= 0) continue;
    await recordReport({
      kind: "cost-unpriced-model",
      source: "server-cost-monitor",
      data: { model: m.model, tokens: m.tokens },
      message: `${m.model}: ${m.tokens.toLocaleString()} tokens priced at $0 (model not in the price table)`,
    });
  }

  for (const s of shrunk) {
    await recordReport({
      kind: "cost-archive-shrink",
      source: "server-cost-monitor",
      data: {
        path: s.path,
        sessionId: s.sessionId,
        archivedTotalTokens: s.archivedTotalTokens,
        liveTotalTokens: s.liveTotalTokens,
      },
      message:
        `${s.sessionId}: transcript re-parsed smaller than the archive ` +
        `(${s.archivedTotalTokens.toLocaleString()} → ${s.liveTotalTokens.toLocaleString()} tokens); kept the archived value`,
    });
  }
}
