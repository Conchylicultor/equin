import { z } from "zod";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { ReportKind, type ReportRow } from "@plugins/reports/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { claudeSpendHoursView } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { costUsageDir } from "../../data-dirs";

// ─── What this is ─────────────────────────────────────────────────────────────
//
// `cost-unpriced-model`: a model the usage ledger holds tokens of that the
// priced view (`claude_spend_hours_v`) cannot price — its rows' `cost_usd` is
// NULL, so every cost surface adds nothing for them. The view refuses to call
// that $0; this report is where the fact lands. `warning`: the charts render,
// they are missing dollars. Filed by the daily refresh, after it recorded the
// newest prices.

// Re-alert at most once per ~24h: an unpriced model stays unpriced until the
// table learns it, so a shorter re-arm would re-ring for a known fact.
const NOTIF_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const UnpricedModelPayloadSchema = z.object({
  /** The model id exactly as the transcript (or a call result) spelled it. */
  model: z.string(),
  /** Tokens left unpriced at the moment of the report (all kinds summed). */
  tokens: z.number(),
});
export type UnpricedModelPayload = z.infer<typeof UnpricedModelPayloadSchema>;

/**
 * One row per distinct unpriced MODEL: the fingerprint is the model id, so a
 * model missing for a year is one row whose `count` grows, and learning its
 * price stops it recurring.
 */
export const unpricedModelKind = ReportKind({
  kind: "cost-unpriced-model",
  schema: UnpricedModelPayloadSchema,
  fingerprint: (d: UnpricedModelPayload) => `cost-unpriced-model:${d.model}`,
  meta: {
    tag: "[cost]",
    notif: "Model missing from the price table",
    variant: "warning",
    category: "error",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = UnpricedModelPayloadSchema.parse(row.data);
    return {
      title: `[cost] Unpriced model: ${d.model}`,
      description: renderUnpriced(row, d),
    };
  },
});

function renderUnpriced(row: ReportRow, d: UnpricedModelPayload): string {
  return [
    `The price history has no rate for the model \`${d.model}\`, so its ` +
      `**${d.tokens.toLocaleString()} tokens** in the usage ledger are unpriced ` +
      `(\`cost_usd\` NULL in \`claude_spend_hours_v\`) and add nothing to any cost.`,
    "",
    `Rates are recorded from the price table (\`${costUsageDir.file("price-table.json")}\`), ` +
      `merge-only and refreshed daily from LiteLLM's ` +
      `\`model_prices_and_context_window.json\`. So an unpriced model means one of:`,
    "",
    `1. **LiteLLM has never carried this key.** If it is genuinely absent ` +
      `upstream, add the rates to the vendored snapshot ` +
      `(\`plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/plugins/price-table/server/internal/litellm-fallback.json\`), ` +
      `which the merge then preserves, or record a correction version.`,
    `2. **The daily refresh has not run yet on this machine** (first boot, or ` +
      `an offline box on the vendored snapshot). It resolves on the next fetch.`,
    `3. **A filter regression** — \`parseLiteLlmTable\` keeps only the ` +
      `Anthropic-relevant slice. If the key exists upstream but not on disk, ` +
      `widen \`isAnthropicRelevant\`.`,
    "",
    `The tokens are **not lost**: the ledger stores tokens, never dollars, so ` +
      `a rate for this model prices its history on every surface at once.`,
    "",
    `**Model:** \`${d.model}\``,
    `**Unpriced tokens (last observation):** ${d.tokens.toLocaleString()}`,
    "",
    `**Occurrences:** ${row.count}`,
    `**Worktree:** ${row.worktree}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  ].join("\n");
}

const v = claudeSpendHoursView;

const UnpricedRowSchema = z.object({ model: z.string(), tokens: z.number() });

/**
 * File `cost-unpriced-model` for every model the priced view leaves unpriced
 * (some hour's `cost_usd` NULL) with tokens to price — Claude Code's
 * `<synthetic>` pseudo-model carries only zeros, which cost nothing under any
 * price. Returns how many were filed.
 */
export async function reportUnpricedModels(exec: DbExecutor): Promise<number> {
  const rows = await executeRows(exec, {
    label: "claude pricing unpriced models",
    query: sql`
      SELECT ${v.model} AS model,
             sum(${v.inputBelow} + ${v.inputAbove} + ${v.outputBelow} + ${v.outputAbove}
               + ${v.cacheReadBelow} + ${v.cacheReadAbove}
               + ${v.cacheCreate5mBelow} + ${v.cacheCreate5mAbove}
               + ${v.cacheCreate1hBelow} + ${v.cacheCreate1hAbove})::float8 AS tokens
        FROM ${v}
       WHERE ${v.costUsd} IS NULL
       GROUP BY ${v.model}
       ORDER BY ${v.model}`,
    row: UnpricedRowSchema,
  });
  let filed = 0;
  for (const m of rows) {
    if (m.tokens <= 0) continue;
    await recordReport({
      kind: "cost-unpriced-model",
      source: "server-cost-monitor",
      data: { model: m.model, tokens: m.tokens },
      message: `${m.model}: ${m.tokens.toLocaleString()} tokens unpriced (model not in the price history)`,
    });
    filed += 1;
  }
  return filed;
}
