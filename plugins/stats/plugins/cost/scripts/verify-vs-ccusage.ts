// ─── The regression gate for our own pricing ──────────────────────────────────
//
//   ./equin run plugins/stats/plugins/cost/scripts/verify-vs-ccusage.ts [--fetch] [--top N]
//
// This script is the ONLY reason `ccusage` is still a dependency of this plugin
// (a dev one). Nothing on the serving path imports it: `price-table.ts` owns the
// LiteLLM rates and `usage-index.ts` owns the parse. That independence is exactly
// what needs a witness — so this runs ccusage over the same corpus and compares,
// side by side:
//
//   1. **ccusage** — `ccusage claude session --json --mode auto`, its
//      `costUSD ?? computed` figure (`costUSD` is absent from every transcript
//      entry we have sampled, so in practice this is pure arithmetic over its
//      own copy of the upstream rates, 1h cache writes at their own rate).
//   2. **ours** — the SHIPPED pricing: `parseTranscript` → `rollup` →
//      `priceBucket`.
//
// A dollar delta alone conflates rates and counting, so the totals are also
// broken down by token kind (input / output / cache create / cache read): a
// counting divergence shows up in the one kind it touches, at the token level,
// independent of any rate. Only a delta with every token kind equal is a
// pricing divergence. Per-project outliers, largest first, follow.
//
// ccusage is a CLI only since 19.0.0 (20.x is a launcher for a native binary),
// so it is driven as one: the `claude` source alone (the bare `session` verb
// would add every other coding-agent CLI it detects), pointed at the same
// directory through `CLAUDE_CONFIG_DIR`, and its JSON parsed against a schema —
// a field it renames fails here, loudly, instead of reading as $0.
//
// It imports OUR modules on purpose. A script that re-derived the pricing itself
// would only prove that two hand-written implementations agree, which is what it
// is supposed to be testing.
//
// The measured divergences live in the plugin's CLAUDE.md (*Known divergences
// from ccusage*). The corpus GROWS, so the absolute dollars move every run; the
// per-kind PERCENTAGES are the invariant.
//
// Flags:
//   --fetch    price with a freshly fetched LiteLLM table instead of the one on
//              disk. Use when the local table is stale enough that a rate
//              difference — not a logic difference — is suspected.
//   --top N    how many per-project outliers to print (default 8).

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CLAUDE_PROJECTS_DIR } from "@plugins/infra/plugins/paths/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { costUsageDir } from "../data-dirs";
import { loadFallbackPriceTable } from "../server/internal/litellm-fallback";
import type { PriceTable } from "../core";
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
/** ccusage's whole-corpus run takes ~12 s today; 10 min is a wedge, not a slow run. */
const CCUSAGE_TIMEOUT_MS = 10 * 60_000;

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

// ─── the per-project totals both sides produce ──────────────────────────────

/** One side's totals for one project: dollars, and tokens by kind. */
interface Totals {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

const TOKEN_KINDS = [
  ["input", "inputTokens"],
  ["output", "outputTokens"],
  ["cache create", "cacheCreationTokens"],
  ["cache read", "cacheReadTokens"],
] as const satisfies readonly (readonly [string, keyof Totals])[];

function emptyTotals(): Totals {
  return {
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

function addInto(map: Map<string, Totals>, key: string, add: Totals): void {
  const t = map.get(key) ?? emptyTotals();
  t.cost += add.cost;
  t.inputTokens += add.inputTokens;
  t.outputTokens += add.outputTokens;
  t.cacheCreationTokens += add.cacheCreationTokens;
  t.cacheReadTokens += add.cacheReadTokens;
  map.set(key, t);
}

function grandTotal(map: Map<string, Totals>): Totals {
  const all = new Map<string, Totals>();
  for (const t of map.values()) addInto(all, "", t);
  return all.get("") ?? emptyTotals();
}

/**
 * The top-level project dir a transcript belongs to. A subagent transcript sits
 * deeper (`<projectDir>/<sessionId>/subagents/…`), where `FilePartial.projectDir`
 * — `basename(dirname(path))` — would read `subagents`; ccusage attributes it to
 * its parent session's project, so both sides key by this instead.
 */
function topProjectDir(relativePath: string): string {
  const [top] = relativePath.split(sep);
  if (top === undefined || top === "") {
    throw new Error(`transcript outside a project dir: ${relativePath}`);
  }
  return top;
}

// ─── ours ────────────────────────────────────────────────────────────────────

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

/**
 * Parse every transcript with `parseTranscript`, bounded so this does not eat
 * the box, re-keyed to its top-level project dir.
 */
async function parseAll(paths: string[]): Promise<Map<string, FilePartial>> {
  const partials = new Map<string, FilePartial>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const path = paths[i];
      if (path === undefined) return;
      const partial = await parseTranscript(path);
      partials.set(path, {
        ...partial,
        projectDir: topProjectDir(relative(CLAUDE_PROJECTS_DIR, path)),
      });
    }
  };
  await Promise.all(Array.from({ length: PARSE_CONCURRENCY }, worker));
  return partials;
}

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

function ourTotalsByProject(
  partials: Map<string, FilePartial>,
  table: PriceTable,
): {
  byProject: Map<string, Totals>;
  unpriced: { model: string; tokens: number }[];
} {
  const { sessions, unpriced } = rollup(partials, table);
  const byProject = new Map<string, Totals>();
  for (const s of sessions) addInto(byProject, s.projectDir, s);
  return { byProject, unpriced };
}

// ─── ccusage ─────────────────────────────────────────────────────────────────

const ccusagePackageSchema = z.object({
  version: z.string(),
  bin: z.object({ ccusage: z.string() }),
});

/** The installed ccusage's launcher (`bin.ccusage`) and version, from its own package.json. */
async function resolveCcusage(): Promise<{ cli: string; version: string }> {
  const manifest = fileURLToPath(import.meta.resolve("ccusage/package.json"));
  const pkg = ccusagePackageSchema.parse(
    JSON.parse(await readFile(manifest, "utf8")),
  );
  return {
    cli: join(dirname(manifest), pkg.bin.ccusage),
    version: pkg.version,
  };
}

/** The slice of `ccusage claude session --json` this script reads. */
const ccusageSessionReportSchema = z.object({
  sessions: z.array(
    z.object({
      projectPath: z.string(),
      totalCost: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheCreationTokens: z.number(),
      cacheReadTokens: z.number(),
    }),
  ),
});

/**
 * ccusage's own totals, keyed by top-level project dir. `projectPath` is the
 * session's directory relative to the projects dir (`<projectDir>`, or deeper
 * for a subagent session).
 */
async function ccusageTotalsByProject(
  cli: string,
): Promise<Map<string, Totals>> {
  const { stdout } = await spawnExpectOk(
    [process.execPath, cli, "claude", "session", "--json", "--mode", "auto"],
    {
      env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE_PROJECTS_DIR },
      timeoutMs: CCUSAGE_TIMEOUT_MS,
    },
  );
  const report = ccusageSessionReportSchema.parse(JSON.parse(stdout));
  const byProject = new Map<string, Totals>();
  for (const row of report.sessions) {
    addInto(byProject, topProjectDir(row.projectPath), {
      ...row,
      cost: row.totalCost,
    });
  }
  return byProject;
}

// ─── reporting ───────────────────────────────────────────────────────────────

const usd = (n: number): string => `$${n.toFixed(2)}`;

function pct(delta: number, base: number): string {
  if (base === 0) return "n/a";
  const p = (delta / base) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(3)}%`;
}

function printTotals(ours: Totals, theirs: Totals): void {
  console.log(
    "\n─── totals: ours − ccusage ─────────────────────────────────────",
  );
  console.log(
    `  cost           ours ${usd(ours.cost).padStart(18)}   ccusage ${usd(theirs.cost).padStart(18)}   ` +
      `${usd(ours.cost - theirs.cost)} (${pct(ours.cost - theirs.cost, theirs.cost)})`,
  );
  for (const [label, key] of TOKEN_KINDS) {
    const a = ours[key];
    const b = theirs[key];
    console.log(
      `  ${label.padEnd(13)}  ours ${a.toLocaleString().padStart(18)}   ccusage ${b.toLocaleString().padStart(18)}   ` +
        `${a - b >= 0 ? "+" : ""}${(a - b).toLocaleString()} (${pct(a - b, b)})`,
    );
  }
}

/** Per-project outliers, largest absolute divergence first — so a regression is diagnosable. */
function printOutliers(
  ours: Map<string, Totals>,
  theirs: Map<string, Totals>,
): void {
  const keys = new Set([...ours.keys(), ...theirs.keys()]);
  const rows = [...keys]
    .map((key) => {
      const a = ours.get(key) ?? emptyTotals();
      const b = theirs.get(key) ?? emptyTotals();
      return { key, a, b, delta: a.cost - b.cost };
    })
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const exact = rows.filter((r) => Math.abs(r.delta) < 0.005).length;
  console.log(
    "\n─── per-project outliers ──────────────────────────────────────",
  );
  console.log(`  projects matching within $0.005: ${exact}/${rows.length}`);
  for (const r of rows.slice(0, TOP)) {
    if (Math.abs(r.delta) < 0.005) break;
    const sign = r.delta >= 0 ? "+" : "";
    // The token kinds that differ, so a row says what kind of divergence it is.
    const kinds = TOKEN_KINDS.filter(([, key]) => r.a[key] !== r.b[key])
      .map(([label, key]) => {
        const d = r.a[key] - r.b[key];
        return `${label} ${d >= 0 ? "+" : ""}${d.toLocaleString()}`;
      })
      .join(", ");
    console.log(
      `  ${sign}${r.delta.toFixed(4).padStart(12)}   ours=${usd(r.a.cost).padStart(10)} ` +
        `ccusage=${usd(r.b.cost).padStart(10)}   ${r.key.slice(-64)}`,
    );
    console.log(`  ${" ".repeat(13)}tokens: ${kinds || "all equal (rates)"}`);
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

const ours = ourTotalsByProject(await parseAll(paths), table);

// Last, and deliberately: ccusage's whole-corpus parse is the slow, memory-hungry
// half (~12 s / ~1.2 GB), so a failure in OUR half surfaces before paying for it.
const ccusage = await resolveCcusage();
console.log(
  `running ccusage ${ccusage.version} claude session --json --mode auto …`,
);
const theirs = await ccusageTotalsByProject(ccusage.cli);

printTotals(grandTotal(ours.byProject), grandTotal(theirs));

if (ours.unpriced.length > 0) {
  console.log(
    "\n─── unpriced models (would be $0 in every chart) ───────────────",
  );
  // A zero-token entry costs nothing and is expected: `<synthetic>` is Claude
  // Code's pseudo-model for local, unbilled turns. The server suppresses those
  // rather than filing a report; here they are printed, flagged, so the list
  // stays a full account of what the table could not resolve.
  for (const u of ours.unpriced) {
    const note =
      u.tokens === 0
        ? "  (zero-token pseudo-model — not reported by the server)"
        : "";
    console.log(`  ${u.model}: ${u.tokens.toLocaleString()} tokens${note}`);
  }
}

printOutliers(ours.byProject, theirs);

console.log(`\ndone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
