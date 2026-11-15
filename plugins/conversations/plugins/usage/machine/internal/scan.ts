import { stat } from "@plugins/packages/plugins/timed-fs/core";
import {
  emptyUsageBuckets,
  foldUsageEntry,
  priceBucket,
  resumeUsageBuckets,
  type DayBucket,
  type PriceTable,
  type SeenEntry,
} from "@plugins/stats/plugins/cost/core";
import type {
  UsageFileKind,
  UsageTailEntry,
} from "../../server/internal/tables";

// The pure half of the usage sync: advance ONE file's scan state over the bytes
// appended to it, price what it counted (once — see `priceFile`), and sum a
// conversation's file rows into totals. No database, so the reading, counting
// and pricing rules are tested on their own.

/** How many counted entries a file row keeps (see `tailHashes` in `tables.ts`). */
const TAIL_HASHES = 64;
const NEWLINE = 0x0a;
const decoder = new TextDecoder();

/** One file's scan state, as stored in `conversation_usage_files`. */
export interface FileScan {
  path: string;
  kind: UsageFileKind;
  /** Byte offset of the first line not yet folded — always a line start. */
  offset: number;
  buckets: DayBucket[];
  /** A bare string is a legacy hash (see `tables.ts`); a scan never writes one. */
  tailHashes: (UsageTailEntry | string)[];
}

/**
 * Whether `scan` was counted before a message counted at its largest output:
 * its tail holds bare hashes, and its output is short by every message whose
 * first line was not its last. Such a row is recounted from the start.
 */
export function isLegacyScan(scan: Pick<FileScan, "tailHashes">): boolean {
  return scan.tailHashes.some((entry) => typeof entry === "string");
}

const isTailEntry = (e: UsageTailEntry | string): e is UsageTailEntry =>
  typeof e !== "string";

/** A file's size, or `null` when it does not exist (yet, or any more). */
async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

/**
 * `prev` advanced over the complete lines `path` now holds — or read from the
 * start when there is no `prev`, when the file shrank (replaced, not appended
 * to), when `prev` is a legacy scan (`isLegacyScan`), or when the caller passes
 * `chainSeen` (a whole-chain re-read: the entries every earlier file of the
 * chain counted). A trailing line with no newline yet is torn (Claude is
 * mid-append) and left for the next read.
 *
 * Returns `prev` itself when nothing was appended, `null` when the file is
 * gone and there is no `prev` to keep. A legacy `prev` whose file is gone
 * cannot be recounted: it keeps its tokens and drops its tail, which only an
 * append would read.
 */
export async function advanceFile(
  path: string,
  kind: UsageFileKind,
  prev: FileScan | undefined,
  chainSeen?: Map<string, SeenEntry>,
): Promise<FileScan | null> {
  const size = await sizeOf(path);
  if (size === null) {
    if (prev !== undefined && isLegacyScan(prev))
      return { ...prev, tailHashes: [] };
    return prev ?? null;
  }
  const restart =
    prev === undefined ||
    size < prev.offset ||
    chainSeen !== undefined ||
    isLegacyScan(prev);
  if (!restart && size === prev.offset) return prev;

  const resumed = restart ? [] : prev.tailHashes.filter(isTailEntry);
  const start = restart ? 0 : prev.offset;
  const fold = restart
    ? {
        ...emptyUsageBuckets("hour"),
        ...(chainSeen ? { seen: chainSeen } : {}),
      }
    : resumeUsageBuckets(
        prev.buckets,
        resumed.map(({ hash, ...entry }) => [hash, entry] as const),
        "hour",
      );
  // This file's counted hashes, oldest first; the fold's `seen` holds each
  // one's current output (a top-up updates it in place).
  const tail = resumed.map((entry) => entry.hash);

  const bytes = await Bun.file(path).slice(start, size).bytes();
  const end = bytes.lastIndexOf(NEWLINE);
  if (end >= 0) {
    for (const raw of decoder.decode(bytes.subarray(0, end)).split("\n")) {
      if (raw === "") continue;
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch (err) {
        // A complete line that is not JSON carries no usage this total can
        // count; it is the transcript reader's to report, not this one's.
        if (!(err instanceof SyntaxError)) throw err;
        continue;
      }
      const counted = foldUsageEntry(fold, line);
      if (counted?.kind === "entry" && counted.hash) tail.push(counted.hash);
    }
  }
  return {
    path,
    kind,
    offset: start + (end >= 0 ? end + 1 : 0),
    buckets: [...fold.buckets.values()],
    tailHashes: tail.slice(-TAIL_HASHES).map((hash) => {
      const entry = fold.seen.get(hash);
      if (entry === undefined)
        throw new Error(`counted hash ${hash} missing from the fold`);
      return { hash, ...entry };
    }),
  };
}

/**
 * A file row's frozen pricing (see `costUsd` / `unpricedModels` in
 * `tables.ts`): what its counted tokens cost when they were counted, and the
 * models the table could not price then.
 */
export interface FilePricing {
  costUsd: number;
  unpricedModels: string[];
}

/**
 * A pricing pass's result: the row's frozen pricing, and what this pass ADDED
 * to its cost, per UTC hour of the priced bucket (`spendHourKey`, an ISO
 * instant; negative for tokens a chain re-read took back). Not stored on the
 * row: the sync files it under the account that spent it
 * (infra/claude-cli/spend-ledger's `claude_spend_hours`). Its values sum to the
 * move of `costUsd`.
 */
export interface PricingPass extends FilePricing {
  addedByHour: Map<string, number>;
}

/** A file row as stored: its scan state and its pricing (`null`: never priced). */
export interface PricedFile extends FileScan {
  costUsd: number | null;
  unpricedModels: string[];
}

/** A bucket's `(date, model, speed)` — the day it counts toward. */
const dayKey = (b: DayBucket): string => `${b.date}\0${b.model}\0${b.speed}`;
/** A bucket's full key: its day, and its hour (none on a legacy bucket). */
const bucketKey = (b: DayBucket): string => `${dayKey(b)}\0${b.hour ?? ""}`;

/** The ten token counts of a bucket, by kind and tier. */
const TOKEN_KINDS = [
  "input",
  "output",
  "cacheRead",
  "cacheCreate5m",
  "cacheCreate1h",
] as const;
const TIERS = ["below", "above"] as const;

type Tokens = Pick<DayBucket, (typeof TOKEN_KINDS)[number]>;

function mapTokens(
  f: (
    kind: (typeof TOKEN_KINDS)[number],
    tier: (typeof TIERS)[number],
  ) => number,
): Tokens {
  const tiered = (kind: (typeof TOKEN_KINDS)[number]) => ({
    below: f(kind, "below"),
    above: f(kind, "above"),
  });
  return {
    input: tiered("input"),
    output: tiered("output"),
    cacheRead: tiered("cacheRead"),
    cacheCreate5m: tiered("cacheCreate5m"),
    cacheCreate1h: tiered("cacheCreate1h"),
  };
}

/**
 * `next`'s buckets minus `prev`'s, per `(date, hour, model, speed)`: the tokens
 * counted since `prev`. Usually only additions; a chain re-read can also take
 * tokens back (a bucket shrinks or goes), and pricing is linear, so the
 * negative delta un-prices them at the rate they are taken back at.
 *
 * A row counted before the fold kept hours holds hourless (day) buckets. An
 * append leaves them as they are (new tokens go to hour buckets beside them);
 * a re-read from the start re-buckets their tokens by hour. Such a day bucket,
 * gone from `next`, is taken out of `next`'s hours of the same day, earliest
 * first — a transcript is append-only, so what was counted before is what came
 * first — and only what is left over (tokens really taken back) stays a
 * negative delta, on the day bucket itself.
 */
function bucketDelta(prev: DayBucket[], next: DayBucket[]): DayBucket[] {
  const before = new Map(prev.map((b) => [bucketKey(b), b]));
  const nextKeys = new Set(next.map(bucketKey));
  const delta: DayBucket[] = next.map((b) => {
    const p = before.get(bucketKey(b));
    return {
      ...b,
      ...mapTokens((kind, tier) => b[kind][tier] - (p?.[kind][tier] ?? 0)),
    };
  });
  const hoursOfDay = new Map<string, DayBucket[]>();
  for (const d of delta) {
    if (d.hour === undefined) continue;
    const day = hoursOfDay.get(dayKey(d)) ?? [];
    day.push(d);
    hoursOfDay.set(dayKey(d), day);
  }
  for (const hours of hoursOfDay.values())
    hours.sort((a, b) => (a.hour ?? 0) - (b.hour ?? 0));
  for (const p of prev) {
    if (nextKeys.has(bucketKey(p))) continue;
    const left: Tokens = mapTokens((kind, tier) => p[kind][tier]);
    if (p.hour === undefined) {
      for (const d of hoursOfDay.get(dayKey(p)) ?? []) {
        for (const kind of TOKEN_KINDS) {
          for (const tier of TIERS) {
            const take = Math.min(left[kind][tier], Math.max(0, d[kind][tier]));
            d[kind][tier] -= take;
            left[kind][tier] -= take;
          }
        }
      }
    }
    delta.push({
      ...p,
      // `0 -`, not `-`: a fully taken-out count stays 0, never -0.
      ...mapTokens((kind, tier) => 0 - left[kind][tier]),
    });
  }
  return delta;
}

/**
 * The ledger hour a priced bucket's cost is filed under, as an ISO instant: its
 * UTC hour, or 00:00 of its day for a legacy (hourless) bucket.
 */
export function spendHourKey(b: Pick<DayBucket, "date" | "hour">): string {
  return `${b.date}T${String(b.hour ?? 0).padStart(2, "0")}:00:00.000Z`;
}

/**
 * Price a file row's move from `prev` to `nextBuckets`, freezing what was
 * already priced: `prev`'s cost stands as it is, a model `prev` could not price
 * that `table` now knows is priced once (its whole buckets), and only the tokens
 * counted since `prev` are priced with `table`. A bucket whose model `table`
 * cannot price adds no cost — its model is kept in `unpricedModels`, and
 * stats/cost's `cost-unpriced-model` report already names it.
 *
 * A `prev` never priced (`costUsd === null`, counted before costs were frozen)
 * is priced whole with `table`.
 */
export function priceFile(
  prev: Pick<PricedFile, "buckets" | "costUsd" | "unpricedModels"> | undefined,
  nextBuckets: DayBucket[],
  table: PriceTable,
): PricingPass {
  const base: { buckets: DayBucket[] } & FilePricing =
    prev === undefined || prev.costUsd === null
      ? { buckets: [], costUsd: 0, unpricedModels: [] }
      : { ...prev, costUsd: prev.costUsd };
  let costUsd = base.costUsd;
  const addedByHour = new Map<string, number>();
  const add = (b: DayBucket, cost: number): void => {
    if (cost === 0) return;
    costUsd += cost;
    const hour = spendHourKey(b);
    addedByHour.set(hour, (addedByHour.get(hour) ?? 0) + cost);
  };
  const unpriced = new Set<string>();
  const wasUnpriced = new Set(base.unpricedModels);
  for (const b of base.buckets) {
    if (!wasUnpriced.has(b.model)) continue;
    const priced = priceBucket(b, table);
    if (priced.ok) add(b, priced.cost);
    else if (priced.tokens !== 0) unpriced.add(b.model);
  }
  for (const b of bucketDelta(base.buckets, nextBuckets)) {
    const priced = priceBucket(b, table);
    if (priced.ok) add(b, priced.cost);
    // No tokens cost nothing, priced or not (here and above): Claude Code's
    // `<synthetic>` pseudo-model only ever carries zeros, and no table will
    // ever price it.
    else if (priced.tokens !== 0) unpriced.add(b.model);
  }
  return { costUsd, unpricedModels: [...unpriced].sort(), addedByHour };
}

/** The totals a conversation's file rows add up to. */
export interface UsageTotals {
  costUsd: number;
  tokens: number;
  cacheReadTokens: number;
  agentCount: number;
}

const tiered = (t: { below: number; above: number }): number =>
  t.below + t.above;

/** Sum the file rows — their tokens, and the cost each was priced at. */
export function totalsOf(
  files: Iterable<Pick<FileScan, "kind" | "buckets"> & FilePricing>,
): UsageTotals {
  const totals: UsageTotals = {
    costUsd: 0,
    tokens: 0,
    cacheReadTokens: 0,
    agentCount: 0,
  };
  for (const file of files) {
    if (file.kind === "subagent") totals.agentCount += 1;
    totals.costUsd += file.costUsd;
    for (const b of file.buckets) {
      totals.tokens +=
        tiered(b.input) +
        tiered(b.output) +
        tiered(b.cacheCreate5m) +
        tiered(b.cacheCreate1h);
      totals.cacheReadTokens += tiered(b.cacheRead);
    }
  }
  // Token counts are whole; the 5m / 1h cache-creation apportioning splits them
  // fractionally (see stats/cost's `buckets.ts`), so the sum carries float noise.
  totals.tokens = Math.round(totals.tokens);
  totals.cacheReadTokens = Math.round(totals.cacheReadTokens);
  return totals;
}
