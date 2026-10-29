import type { RoutePrediction } from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { RouteDef, RoutesData } from "./types";

/** A route's decision as the docs spell it: `predicted`, `unpredicted (precondition)`, `debt: upsert`, … */
export function predictionLabel(p: RoutePrediction): string {
  if (typeof p === "string") return p;
  return "unpredicted" in p
    ? `unpredicted (${p.unpredicted})`
    : `debt: ${p.debt}`;
}

/** One route's doc line: the route, then its decision when it is a write. */
export function renderRoute(r: RouteDef): string {
  return r.prediction === undefined
    ? `\`${r.route}\``
    : `\`${r.route}\` — ${predictionLabel(r.prediction)}`;
}

/** Longest gap listing printed in full; a longer one is one count per plugin. */
const GAP_LIST_MAX = 20;

export interface PredictionDebtEntry {
  gap: string;
  routes: { plugin: string; route: string }[];
}

/**
 * Every route declaring `unpredicted: { gap }`, grouped by gap (alphabetical),
 * each gap's routes ordered by plugin then route. `plugins` pairs a plugin's
 * path with its routes facet data.
 */
export function predictionDebt(
  plugins: readonly { plugin: string; data: RoutesData | undefined }[],
): PredictionDebtEntry[] {
  const byGap = new Map<string, PredictionDebtEntry["routes"]>();
  for (const { plugin, data } of plugins) {
    for (const r of data?.routes ?? []) {
      const p = r.prediction;
      if (typeof p !== "object" || !("debt" in p)) continue;
      const list = byGap.get(p.debt) ?? [];
      list.push({ plugin, route: r.route });
      byGap.set(p.debt, list);
    }
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...byGap]
    .sort(([a], [b]) => cmp(a, b))
    .map(([gap, routes]) => ({
      gap,
      routes: routes.sort(
        (a, b) => cmp(a.plugin, b.plugin) || cmp(a.route, b.route),
      ),
    }));
}

/**
 * The details doc's "Prediction debt by gap" index: per gap, the route count
 * and the routes. A gap past {@link GAP_LIST_MAX} routes is summarized as one
 * count per plugin (the doc-wide convention for long lists). Empty when there
 * is no debt.
 */
export function renderPredictionDebt(entries: PredictionDebtEntry[]): string[] {
  if (entries.length === 0) return [];
  const lines = ["## Prediction debt by gap", ""];
  for (const { gap, routes } of entries) {
    lines.push(
      `- \`${gap}\` — ${routes.length} route${routes.length === 1 ? "" : "s"}`,
    );
    if (routes.length <= GAP_LIST_MAX) {
      for (const r of routes)
        lines.push(`  - \`${r.route}\` (\`${r.plugin}\`)`);
      continue;
    }
    const perPlugin = new Map<string, number>();
    for (const r of routes)
      perPlugin.set(r.plugin, (perPlugin.get(r.plugin) ?? 0) + 1);
    for (const [plugin, n] of [...perPlugin].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    ))
      lines.push(`  - \`${plugin}\` ×${n}`);
  }
  return lines;
}
