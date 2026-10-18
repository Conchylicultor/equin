import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { BootBudgetPayloadSchema, type BootBudgetPayload } from "../../core";

// Re-alert the bell at most once per ~6h while a boot span keeps blowing its
// budget across restarts. A hook that is slow on every boot is a persistent
// condition, so the cooldown re-surfaces it periodically without spamming —
// matching the live-state-noop / render-loop 6h re-arm.
const BOOT_BUDGET_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// The `boot-budget` report kind. Dedups per distinct boot span (fingerprint
// `boot-budget:<spanName>`), so a hook that is slow on every boot collapses to a
// single task whose `count` discriminates a one-off slow boot (count 1) from a
// hook that is chronically slow (count grows across restarts). Variant `warning`:
// a slow boot hook is a structural cost regression — every backend re-pays it on
// every launch — but not a crash, so it degrades boot rather than breaking it.
export const bootBudgetKind = ReportKind({
  kind: "boot-budget",
  schema: BootBudgetPayloadSchema,
  fingerprint: (d: BootBudgetPayload) => `boot-budget:${d.spanName}`,
  meta: {
    tag: "[boot-budget]",
    notif: "Slow boot hook",
    variant: "warning",
    notifCooldownMs: BOOT_BUDGET_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = BootBudgetPayloadSchema.parse(row.data);
    return {
      title: `[boot-budget] Slow boot hook: ${d.spanName} (${d.durationMs}ms)`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: BootBudgetPayload): string {
  const lines: string[] = [];
  lines.push(
    `The server boot span \`${d.spanName}\`${d.plugin ? ` (plugin \`${d.plugin}\`)` : ""} ` +
      `ran for **${d.durationMs}ms** in the \`${d.phase}\` phase — over its ` +
      `**${d.budgetMs}ms** budget.`,
  );
  lines.push("");
  lines.push(
    `Boot work is re-paid on **every** backend boot: main after each ` +
      `\`./singularity build\`, **plus** every worktree agent backend on launch. ` +
      `A heavy boot hook silently degrades every one of those — the whole reason ` +
      `this budget exists (see ` +
      `research/2026-07-08-global-bounding-boot-time-work.md).`,
  );
  lines.push("");
  lines.push(
    `**What to do:** if the work is a genuine warm-up (index build, corpus scan, ` +
      `backfill), move it off the eager \`onReady\` path into a declared ` +
      `\`defineWarmup\` (throttled, scope-gated, deferred past serving-ready) so it ` +
      `no longer competes with first requests. If it must be eager, make it ` +
      `incremental (fingerprint-keyed, skip-if-unchanged) or gate it to main only.`,
  );
  lines.push("");
  lines.push(
    `**Caveat — a long span is not always a blocked loop:** a span can be long ` +
      `because it *awaited IO* (flat RSS) rather than *burned CPU* (RSS spikes). ` +
      `The phase-boundary memory checkpoints below are the authoritative ` +
      `discriminator — a jump in phys_footprint across this span's phase points at ` +
      `real heavy work; flat memory points at IO wait. (Event-loop-block ` +
      `attribution is a follow-up — see this plugin's CLAUDE.md.)`,
  );
  lines.push("");
  lines.push(`**Span:** \`${d.spanName}\``);
  lines.push(`**Phase:** ${d.phase}`);
  if (d.plugin) lines.push(`**Plugin:** \`${d.plugin}\``);
  lines.push(`**Duration:** ${d.durationMs}ms`);
  lines.push(`**Budget:** ${d.budgetMs}ms`);
  if (d.memoryCheckpoints && d.memoryCheckpoints.length > 0) {
    lines.push("");
    lines.push(`**Phase-boundary memory (phys_footprint / heapUsed):**`);
    for (const c of d.memoryCheckpoints) {
      lines.push(
        `- \`${c.label}\` @ ${c.atMs}ms — ${c.physFootprintMb} MB / ${c.heapUsedMb} MB`,
      );
    }
  }
  lines.push("");
  lines.push(`**Occurrences (slow boots):** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
