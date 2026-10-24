// ─── The regression gate for our own pricing ──────────────────────────────────
//
//   ./equin run plugins/stats/plugins/cost/scripts/verify-vs-ccusage.ts [--fetch] [--top N]
//
// This script is the ONLY reason `ccusage` is still a dependency of this plugin
// (a dev one). Nothing on the serving path imports it: `price-table.ts` owns the
// LiteLLM rates and `usage-index.ts` owns the parse. That independence is exactly
// what needs a witness — so this runs ccusage's own `loadSessionData` over the
// same corpus and prints three totals:
//
//   1. **ccusage** — its `mode:"auto"` figure (`costUSD ?? LiteLLM arithmetic`;
//      `costUSD` is absent from every transcript entry we have sampled, so in
//      practice this is pure arithmetic over the upstream table).
//   2. **ours** — the SHIPPED pricing: `parseTranscript` → `rollup` →
//      `priceBucket`, including the 1h cache-creation rate ccusage's valibot
//      schema omits.
//   3. **ours, 5m-only control** — the identical pass with every model's 1h
//      cache-creation rate forced down to its 5m rate, i.e. ccusage's semantics.
//
// The three exist because a single "ours vs theirs" delta conflates two
// independent divergences. The control isolates them: `control − ccusage` is the
// cross-file dedup gap alone (we dedupe per file, ccusage dedupes globally), and
// `ours − control` is the deliberate 1h correction alone. A regression in either
// one is then attributable instead of just visible.
//
// It imports OUR modules on purpose. A script that re-derived the pricing itself
// would only prove that two hand-written implementations agree, which is what it
// is supposed to be testing.
//
// ── Measured 2026-08-06, on this machine's corpus (1,770 transcripts) ─────────
//
//   ccusage                $14,180.76
//   ours (5m-only control) $14,242.08   +0.432 %   ← the dedup gap alone
//   ours (shipped)         $15,373.20   +8.409 %   ← dedup gap + 1h correction
//   the 1h correction alone             +$1,131.12 (+7.942 % of the control)
//
// The corpus GROWS, so the absolute dollars move every time this is run; the two
// PERCENTAGES are the invariant. Read a jump in the control's percentage as a
// dedup/parse regression (or a spike in `claude --resume --fork-session` usage,
// which inflates it legitimately — a fork copies the parent transcript into a new
// file), and a jump in the shipped percentage with a flat control as a change in
// the 1h/5m token mix or in LiteLLM's 1h premium.
//
// Flags:
//   --fetch    price with a freshly fetched LiteLLM table instead of the one on
//              disk. Use when the local table is stale enough that a rate
//              difference — not a logic difference — is suspected.
//   --top N    how many per-project outliers to print (default 8).

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadSessionData } from "ccusage/data-loader";
import { CLAUDE_PROJECTS_DIR } from "@plugins/infra/plugins/paths/core";
import { costUsageDir } from "../data-dirs";
import { loadFallbackPriceTable } from "../server/internal/litellm-fallback";
import type { ModelPrice, PriceTable } from "../core";
import {
  fetchPriceTable,
  loadPriceTable,
  mergePriceTable,
} from "../server/internal/price-table";
import {
  parseTranscript,
  rollup,
  type FilePartial,
} from "../server/internal/usage-index";

const PARSE_CONCURRENCY = 8;

// ─── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const wantFetch = argv.includes("--fetch");
const topIndex = argv.indexOf("--top");
const TOP = topIndex >= 0 ? Number(argv[topIndex + 1] ?? "8") : 8;
if (!Number.isFinite(TOP) || TOP < 0) {
  throw new Error(
    `--top expects a non-negative number, got ${String(argv[topIndex + 1])}`,
  );
}

// ─── the corpus ──────────────────────────────────────────────────────────────

/** Every `*.jsonl` under `~/.claude/projects`, the same set the corpus index enumerates. */
async function listTranscripts(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTranscripts(path)));
    else if (entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

/** Parse every transcript with `parseTranscript`, bounded so this does not eat the box. */
async function parseAll(paths: string[]): Promise<Map<string, FilePartial>> {
  const partials = new Map<string, FilePartial>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const path = paths[i];
      if (path === undefined) return;
      partials.set(path, await parseTranscript(path));
    }
  };
  await Promise.all(Array.from({ length: PARSE_CONCURRENCY }, worker));
  return partials;
}

// ─── the two price tables ────────────────────────────────────────────────────

/**
 * The table the SERVER would use: the persisted one, falling back to the vendored
 * snapshot exactly as `load-usage.ts` does. `--fetch` layers a live LiteLLM fetch
 * on top through the real `mergePriceTable`.
 */
async function resolveTable(): Promise<{ table: PriceTable; source: string }> {
  const priceTablePath = costUsageDir.file("price-table.json");
  const persisted = await loadPriceTable(priceTablePath);
  const base = persisted ?? (await loadFallbackPriceTable());
  const baseSource = persisted
    ? priceTablePath
    : "vendored litellm-fallback.json";
  if (!wantFetch) return { table: base, source: baseSource };
  const merged = mergePriceTable(base, await fetchPriceTable());
  return { table: merged, source: `${baseSource} + live LiteLLM fetch` };
}

/**
 * ccusage's semantics: its valibot schema has no
 * `cache_creation_input_token_cost_above_1hr` field, so a 1h cache write is
 * billed at the 5m rate. Forcing our 1h rates down to the 5m ones reproduces that
 * exactly, WITHOUT touching the parse — same tokens, same buckets, same
 * `priceBucket`, one rate substituted. That is what makes the control a control.
 */
function fiveMinuteOnly(table: PriceTable): PriceTable {
  const models: Record<string, ModelPrice> = {};
  for (const [key, price] of Object.entries(table.models)) {
    const next: ModelPrice = { ...price, cacheCreate1h: price.cacheCreate5m };
    // Absent must stay ABSENT: an untiered model with a present-but-undefined
    // `cacheCreate1hAbove200k` would be a different shape, not a different rate.
    if (price.cacheCreate5mAbove200k === undefined)
      delete next.cacheCreate1hAbove200k;
    else next.cacheCreate1hAbove200k = price.cacheCreate5mAbove200k;
    models[key] = next;
  }
  return { fetchedAt: table.fetchedAt, models };
}

// ─── per-project totals ──────────────────────────────────────────────────────

function ourCostsByProject(
  partials: Map<string, FilePartial>,
  table: PriceTable,
): {
  byProject: Map<string, number>;
  unpriced: { model: string; tokens: number }[];
} {
  const { sessions, unpriced } = rollup(partials, table);
  const byProject = new Map<string, number>();
  for (const s of sessions) {
    byProject.set(s.projectDir, (byProject.get(s.projectDir) ?? 0) + s.cost);
  }
  return { byProject, unpriced };
}

/**
 * ccusage's own totals, keyed by project dir. For the two-level Claude layout
 * (`<projectDir>/<sessionId>.jsonl`) `loadSessionData` reports the project dir as
 * `sessionId`, which is the same key `FilePartial.projectDir` carries.
 */
async function ccusageCostsByProject(): Promise<Map<string, number>> {
  const rows = await loadSessionData({ mode: "auto" });
  const byProject = new Map<string, number>();
  for (const row of rows) {
    byProject.set(
      row.sessionId,
      (byProject.get(row.sessionId) ?? 0) + row.totalCost,
    );
  }
  return byProject;
}

// ─── reporting ───────────────────────────────────────────────────────────────

const usd = (n: number): string => `$${n.toFixed(2)}`;
const sum = (m: Map<string, number>): number =>
  [...m.values()].reduce((a, b) => a + b, 0);

function pct(delta: number, base: number): string {
  if (base === 0) return "n/a";
  const p = (delta / base) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(3)}%`;
}

/** Per-project outliers, largest absolute divergence first — so a regression is diagnosable. */
function printOutliers(
  label: string,
  ours: Map<string, number>,
  theirs: Map<string, number>,
): void {
  const keys = new Set([...ours.keys(), ...theirs.keys()]);
  const rows = [...keys]
    .map((key) => {
      const a = ours.get(key) ?? 0;
      const b = theirs.get(key) ?? 0;
      return { key, a, b, delta: a - b };
    })
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const exact = rows.filter((r) => Math.abs(r.delta) < 0.005).length;
  console.log(`\n${label}`);
  console.log(`  projects matching within $0.005: ${exact}/${rows.length}`);
  for (const r of rows.slice(0, TOP)) {
    if (Math.abs(r.delta) < 0.005) break;
    const sign = r.delta >= 0 ? "+" : "";
    console.log(
      `  ${sign}${r.delta.toFixed(4).padStart(12)}   ours=${usd(r.a).padStart(10)} ` +
        `ccusage=${usd(r.b).padStart(10)}   ${r.key.slice(-64)}`,
    );
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

const startedAt = Date.now();

const { table, source } = await resolveTable();
console.log(`price table: ${source}`);
console.log(
  `             ${Object.keys(table.models).length} models, fetched ` +
    `${new Date(table.fetchedAt).toISOString()}`,
);

const paths = await listTranscripts(CLAUDE_PROJECTS_DIR);
console.log(
  `corpus:      ${paths.length} transcripts under ${CLAUDE_PROJECTS_DIR}`,
);

const partials = await parseAll(paths);
const shipped = ourCostsByProject(partials, table);
const control = ourCostsByProject(partials, fiveMinuteOnly(table));

// Last, and deliberately: ccusage's whole-corpus parse is the slow, memory-hungry
// half (~9.8 s / ~3.3 GB), so a failure in OUR half surfaces before paying for it.
console.log('running ccusage loadSessionData({mode:"auto"}) …');
const theirs = await ccusageCostsByProject();

const shippedTotal = sum(shipped.byProject);
const controlTotal = sum(control.byProject);
const theirsTotal = sum(theirs);

console.log(
  "\n─── totals ─────────────────────────────────────────────────────",
);
console.log(`  ccusage                 ${usd(theirsTotal).padStart(12)}`);
console.log(
  `  ours, 5m-only control   ${usd(controlTotal).padStart(12)}   ` +
    `${usd(controlTotal - theirsTotal)} (${pct(controlTotal - theirsTotal, theirsTotal)}) ` +
    `— cross-file dedup gap, expect ~+0.4%`,
);
console.log(
  `  ours, shipped           ${usd(shippedTotal).padStart(12)}   ` +
    `${usd(shippedTotal - theirsTotal)} (${pct(shippedTotal - theirsTotal, theirsTotal)}) ` +
    `— dedup gap + 1h correction, expect ~+8.1%`,
);
console.log(
  `  of which the 1h correction alone: ${usd(shippedTotal - controlTotal)} ` +
    `(${pct(shippedTotal - controlTotal, controlTotal)})`,
);

if (shipped.unpriced.length > 0) {
  console.log(
    "\n─── unpriced models (would be $0 in every chart) ───────────────",
  );
  // A zero-token entry costs nothing and is expected: `<synthetic>` is Claude
  // Code's pseudo-model for local, unbilled turns. The server suppresses those
  // rather than filing a report; here they are printed, flagged, so the list
  // stays a full account of what the table could not resolve.
  for (const u of shipped.unpriced) {
    const note =
      u.tokens === 0
        ? "  (zero-token pseudo-model — not reported by the server)"
        : "";
    console.log(`  ${u.model}: ${u.tokens.toLocaleString()} tokens${note}`);
  }
}

printOutliers(
  "─── per-project outliers: 5m-only control vs ccusage ───",
  control.byProject,
  theirs,
);
printOutliers(
  "─── per-project outliers: shipped vs ccusage ───────────",
  shipped.byProject,
  theirs,
);

console.log(`\ndone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
