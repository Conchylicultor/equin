import { basename, dirname } from "node:path";
import {
  emptyUsageBuckets,
  foldUsageEntry,
  priceBucket,
  type DayBucket,
  type PriceTable,
  type TieredTokens,
} from "../../core";

// ─── What this is ──────────────────────────────────────────────────────────────
//
// The COST-SPECIFIC half of the usage pipeline. The generic incremental
// file-index mechanics (enumerate → fingerprint-diff → bounded parse → atomic
// persist → drop-vanished) live in `@plugins/infra/plugins/corpus-index`;
// `load-usage.ts` drives a `defineCorpusIndex` instance keyed on `FilePartial`
// with `parseTranscript` as the per-file parse. This file owns only:
//
//   • `parseTranscript` — the token parse of one JSONL transcript (pricing-free);
//   • `rollup`          — the pure in-memory rollup of the per-file partials into
//                         daily/session bundles, priced EXACTLY per bucket from
//                         the price table.
//
// Pricing is not stored here and never baked into a partial: a bucket carries
// the tier-decomposed token counts (`buckets.ts`) and `rollup` turns them into
// dollars with today's table, so the archive stays re-priceable forever.
//
// Bump `INDEX_VERSION` whenever `FilePartial`'s shape — or what the parse counts
// into it — changes: the corpus index treats a version mismatch as empty and
// rebuilds. (4: a message counts at its largest output, not its first line's.)
export const INDEX_VERSION = 4;

/**
 * The per-file token aggregate for one session file. Pricing-free by design:
 * cost is derived at rollup from the price table, never stored per file. This is
 * the corpus index's `TPartial`, and the unit the permanent archive persists.
 *
 * The scalar totals are redundant with `dayBuckets` but kept deliberately —
 * `handleTokenMix` and the session rows read them directly, and recomputing them
 * from the buckets on every read would cost more than the five numbers.
 * `cacheCreationTokens` is 5m + 1h combined.
 */
export interface FilePartial {
  sessionId: string;
  projectDir: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  lastActivity: string; // YYYY-MM-DD (latest entry day)
  modelsUsed: string[];
  dayBuckets: DayBucket[];
}

// ─── Rollup output ───────────────────────────────────────────────────────────

/**
 * One `(date, project)` daily row — the local replacement for ccusage's
 * `DailyUsage`, carrying exactly the fields the handlers read.
 */
export interface DailyRow {
  date: string;
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelBreakdowns: { modelName: string; cost: number }[];
  totalCost: number;
}

/** Per-session rollup (one per file); `isRepo` is added by the caller. */
export interface SessionRollup {
  sessionId: string;
  projectDir: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  lastActivity: string;
  modelsUsed: string[];
}

/** A model the price table could not resolve, with the tokens it left unpriced. */
export interface UnpricedModel {
  model: string;
  tokens: number;
}

// ─── Parse one file (tokens only, pricing-free) ──────────────────────────────

/**
 * The corpus index's per-file `parse`. Token-only, pricing-free, side-effect
 * free. `projectDir`/`sessionId` are derived from the (2-level
 * `<projectDir>/<sessionId>.jsonl`) path so the parse needs only the full path.
 */
export async function parseTranscript(path: string): Promise<FilePartial> {
  const sessionId = basename(path, ".jsonl");
  const projectDir = basename(dirname(path));
  const text = await Bun.file(path)
    .text()
    .catch(() => "");
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let lastActivity = "";
  const models = new Set<string>();
  // Within-file dedup by ccusage's entry hash (`foldUsageEntry`), each message
  // at its largest output, matching its counting. Rare cross-file duplicates are NOT deduped — persisting every hash
  // would bloat the index by hundreds of MB. Measured divergence: +$56.52 on
  // $13,980.67 (+0.404%), i.e. we over-count. This gap GROWS with
  // `--fork-session`, because a fork copies the parent transcript into a new
  // file, so every fork double-counts the parent's whole history.
  const fold = emptyUsageBuckets();

  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      continue; // tolerate a malformed line
    }
    const counted = foldUsageEntry(fold, obj);
    if (!counted) continue;

    inputTokens += counted.input;
    outputTokens += counted.output;
    cacheCreationTokens += counted.cacheCreation;
    cacheReadTokens += counted.cacheRead;
    if (counted.day && counted.day > lastActivity) lastActivity = counted.day;
    if (counted.model) models.add(counted.model);
  }

  return {
    sessionId,
    projectDir,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens:
      inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    lastActivity,
    modelsUsed: [...models],
    dayBuckets: [...fold.buckets.values()],
  };
}

// ─── Rollup (pure, in-memory) ────────────────────────────────────────────────

function tieredTotal(t: TieredTokens): number {
  return t.below + t.above;
}

/**
 * Roll the per-file partials (keyed by path — `corpusIndex.entries()`, merged
 * with the archive) up into daily/session bundles.
 *
 * Cost is EXACT everywhere: each `(date, model, speed)` bucket is priced on its
 * own by `priceBucket`, and a session total, a daily total and a model
 * breakdown are all plain sums of bucket costs. There is no token-share
 * approximation left anywhere in this pipeline — the previous scheme took
 * ccusage's per-PROJECT total and divided it across the project's files by token
 * count, which could not survive an archive whose files ccusage never sees.
 *
 * Buckets whose model the table cannot resolve contribute `$0` **and** an entry
 * in `unpriced` (deduped by model, tokens summed). The caller decides what that
 * means — this function neither throws nor pretends the bucket was free.
 */
export function rollup(
  entries: Map<string, FilePartial>,
  table: PriceTable,
): {
  daily: DailyRow[];
  sessions: SessionRollup[];
  unpriced: UnpricedModel[];
} {
  const sessions: SessionRollup[] = [];
  // Daily rows keyed `${date} ${projectDir}`.
  const dailyMap = new Map<
    string,
    DailyRow & { _models: Map<string, number> }
  >();
  const unpricedMap = new Map<string, number>();

  // Stable order for deterministic output.
  const sorted = [...entries.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  for (const [, p] of sorted) {
    let sessionCost = 0;

    for (const b of p.dayBuckets) {
      const priced = priceBucket(b, table);
      let cost: number;
      if (priced.ok) {
        cost = priced.cost;
      } else {
        cost = 0;
        unpricedMap.set(
          priced.model,
          (unpricedMap.get(priced.model) ?? 0) + priced.tokens,
        );
      }
      sessionCost += cost;

      const key = `${b.date} ${p.projectDir}`;
      let row = dailyMap.get(key);
      if (!row) {
        row = {
          date: b.date,
          project: p.projectDir,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          modelBreakdowns: [],
          totalCost: 0,
          _models: new Map(),
        };
        dailyMap.set(key, row);
      }
      row.inputTokens += tieredTotal(b.input);
      row.outputTokens += tieredTotal(b.output);
      row.cacheCreationTokens +=
        tieredTotal(b.cacheCreate5m) + tieredTotal(b.cacheCreate1h);
      row.cacheReadTokens += tieredTotal(b.cacheRead);
      row._models.set(b.model, (row._models.get(b.model) ?? 0) + cost);
      row.totalCost += cost;
    }

    sessions.push({
      sessionId: p.sessionId,
      projectDir: p.projectDir,
      totalTokens: p.totalTokens,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      cacheCreationTokens: p.cacheCreationTokens,
      cacheReadTokens: p.cacheReadTokens,
      cost: sessionCost,
      lastActivity: p.lastActivity,
      modelsUsed: p.modelsUsed,
    });
  }

  const daily: DailyRow[] = [];
  for (const row of dailyMap.values()) {
    const { _models, ...rest } = row;
    rest.modelBreakdowns = [..._models.entries()].map(([modelName, cost]) => ({
      modelName,
      cost,
    }));
    daily.push(rest);
  }
  const unpriced = [...unpricedMap.entries()].map(([model, tokens]) => ({
    model,
    tokens,
  }));
  return { daily, sessions, unpriced };
}
