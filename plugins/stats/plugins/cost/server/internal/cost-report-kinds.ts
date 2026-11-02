import { z } from "zod";
import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { costUsageDir } from "../../data-dirs";

// ─── What these are ───────────────────────────────────────────────────────────
//
// The two ways the permanent cost archive can be quietly WRONG, each surfaced as
// its own report kind rather than a log line nobody reads:
//
//   • `cost-unpriced-model` — the price table has no entry for a model the
//     corpus used, so its buckets contributed $0. `priceBucket` refuses to
//     express that as a price, so this is the only place the fact can land.
//   • `cost-archive-shrink` — a transcript came back with FEWER tokens than the
//     archive already banked for it, i.e. it was truncated in place. The archived
//     value wins (see `mergeLive`), and this is the record that it happened.
//
// Both are `warning`, not `error`: charts still render, they are just missing
// dollars or explaining a divergence.

// Re-alert at most once per ~24h. Both conditions are steady-state — an unpriced
// model stays unpriced on every read until the table learns it, and a truncated
// transcript stays truncated — so a shorter re-arm would just re-ring the bell
// for a fact the user has already seen, and no re-arm at all would let a
// months-later recurrence pass silently.
const COST_NOTIF_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const UnpricedModelPayloadSchema = z.object({
  /** The model id exactly as the transcript spelled it. */
  model: z.string(),
  /** Tokens left unpriced at the moment of the report (all kinds summed). */
  tokens: z.number(),
});
export type UnpricedModelPayload = z.infer<typeof UnpricedModelPayloadSchema>;

/**
 * One row per distinct unpriced MODEL — not per bucket, per session or per read.
 * The fingerprint is the model id, so a model missing from the table for a year
 * is one row whose `count` grows, and learning its price simply stops the row
 * from recurring.
 */
export const unpricedModelKind = ReportKind({
  kind: "cost-unpriced-model",
  schema: UnpricedModelPayloadSchema,
  fingerprint: (d: UnpricedModelPayload) => `cost-unpriced-model:${d.model}`,
  meta: {
    tag: "[cost]",
    notif: "Model missing from the price table",
    variant: "warning",
    notifCooldownMs: COST_NOTIF_COOLDOWN_MS,
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
    `The cost pipeline could not resolve a price for the model \`${d.model}\`, so ` +
      `**${d.tokens.toLocaleString()} tokens** contributed **$0** to every chart ` +
      `that read them.`,
    "",
    `The price table (\`${costUsageDir.file("price-table.json")}\`) is merge-only — it is ` +
      `refreshed daily from LiteLLM's ` +
      `\`model_prices_and_context_window.json\` and never drops a key it has ` +
      `learned. So an unpriced model means one of:`,
    "",
    `1. **LiteLLM has never carried this key.** Check the upstream table for the ` +
      `id above. If it is genuinely absent, the honest fix is to add the rates to ` +
      `the vendored snapshot (\`server/internal/litellm-fallback.json\`), which the ` +
      `merge then preserves forever.`,
    `2. **The daily refresh has not run yet on this machine** (first boot, or an ` +
      `offline box falling back to the vendored snapshot). It resolves itself on ` +
      `the next successful fetch.`,
    `3. **A filter regression** — \`parseLiteLlmTable\` keeps only the ` +
      `Anthropic-relevant slice of ~3,000 upstream models. If the key exists ` +
      `upstream but not on disk, widen \`isAnthropicRelevant\`.`,
    "",
    `Until then the tokens are **not lost** — the archive stores tokens, never ` +
      `dollars, so learning the price re-prices this history retroactively on the ` +
      `next read.`,
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

export const ArchiveShrinkPayloadSchema = z.object({
  /** Full transcript path — the archive's own key, so the fingerprint is exact. */
  path: z.string(),
  sessionId: z.string(),
  archivedTotalTokens: z.number(),
  liveTotalTokens: z.number(),
});
export type ArchiveShrinkPayload = z.infer<typeof ArchiveShrinkPayloadSchema>;

/**
 * One row per transcript that shrank. Fingerprinted on the path (the archive's
 * own key) rather than the session id, so the row names exactly the file to look
 * at and a re-shrink of the same file collapses onto it.
 */
export const archiveShrinkKind = ReportKind({
  kind: "cost-archive-shrink",
  schema: ArchiveShrinkPayloadSchema,
  fingerprint: (d: ArchiveShrinkPayload) => `cost-archive-shrink:${d.path}`,
  meta: {
    tag: "[cost]",
    notif: "Transcript shrank against the archive",
    variant: "warning",
    notifCooldownMs: COST_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = ArchiveShrinkPayloadSchema.parse(row.data);
    return {
      title: `[cost] Transcript truncated in place: ${d.sessionId}`,
      description: renderShrink(row, d),
    };
  },
});

function renderShrink(row: ReportRow, d: ArchiveShrinkPayload): string {
  const lost = d.archivedTotalTokens - d.liveTotalTokens;
  return [
    `The transcript \`${d.path}\` re-parsed to **${d.liveTotalTokens.toLocaleString()} ` +
      `tokens**, but the permanent archive had already banked ` +
      `**${d.archivedTotalTokens.toLocaleString()}** for the same file — it lost ` +
      `**${lost.toLocaleString()} tokens** in place.`,
    "",
    `A transcript is append-only in normal operation, so this is an anomaly, not a ` +
      `routine event. Plausible causes: the file was rewritten or replaced by an ` +
      `external tool; a partial/interrupted write was observed mid-flight; or a ` +
      `parse-shape change made this binary read fewer tokens out of the same bytes ` +
      `(a recent change to \`usage-index.ts\` or what it imports rebuilds the index).`,
    "",
    `**No history was lost.** \`mergeLive\` keeps the banked partial whenever the ` +
      `live one is smaller, so the charts still show the larger figure. This report ` +
      `exists so the shrink is visible instead of silent — if the SMALLER value is ` +
      `the correct one (a genuine parse fix), the archived entry for this path has ` +
      `to be corrected deliberately.`,
    "",
    `**Session:** \`${d.sessionId}\``,
    `**Path:** \`${d.path}\``,
    `**Archived / live tokens:** ${d.archivedTotalTokens.toLocaleString()} → ` +
      `${d.liveTotalTokens.toLocaleString()}`,
    "",
    `**Occurrences:** ${row.count}`,
    `**Worktree:** ${row.worktree}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  ].join("\n");
}
