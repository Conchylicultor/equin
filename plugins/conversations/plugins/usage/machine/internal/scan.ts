import { stat } from "node:fs/promises";
import {
  emptyUsageBuckets,
  foldUsageEntry,
  priceBucket,
  resumeUsageBuckets,
  type DayBucket,
  type PriceTable,
} from "@plugins/stats/plugins/cost/core";
import type { UsageFileKind } from "../../server/internal/tables";

// The pure half of the usage sync: advance ONE file's scan state over the bytes
// appended to it, and sum a conversation's file rows into priced totals. No
// database, so the reading and counting rules are tested on their own.

/** How many dedup hashes a file row keeps (see `tailHashes` in `tables.ts`). */
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
  tailHashes: string[];
}

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
 * to), or when the caller passes `chainSeen` (a whole-chain re-read: the
 * hashes every earlier file of the chain counted). A trailing line with no
 * newline yet is torn (Claude is mid-append) and left for the next read.
 *
 * Returns `prev` itself when nothing was appended, `null` when the file is
 * gone and there is no `prev` to keep.
 */
export async function advanceFile(
  path: string,
  kind: UsageFileKind,
  prev: FileScan | undefined,
  chainSeen?: Set<string>,
): Promise<FileScan | null> {
  const size = await sizeOf(path);
  if (size === null) return prev ?? null;
  const restart =
    prev === undefined || size < prev.offset || chainSeen !== undefined;
  if (!restart && size === prev.offset) return prev;

  const start = restart ? 0 : prev.offset;
  const fold = restart
    ? { ...emptyUsageBuckets(), ...(chainSeen ? { seen: chainSeen } : {}) }
    : resumeUsageBuckets(prev.buckets, prev.tailHashes);
  const tail = restart ? [] : [...prev.tailHashes];

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
      if (counted?.hash) tail.push(counted.hash);
    }
  }
  return {
    path,
    kind,
    offset: start + (end >= 0 ? end + 1 : 0),
    buckets: [...fold.buckets.values()],
    tailHashes: tail.slice(-TAIL_HASHES),
  };
}

/** The totals a conversation's file rows add up to, priced with `table`. */
export interface UsageTotals {
  costUsd: number;
  tokens: number;
  cacheReadTokens: number;
  agentCount: number;
}

const tiered = (t: { below: number; above: number }): number =>
  t.below + t.above;

/**
 * Sum the file rows. A bucket whose model the table cannot price adds no cost
 * here — stats/cost's `cost-unpriced-model` report already names that model,
 * and the next price-table refresh re-prices every conversation from its
 * stored buckets (`conversations.usage.reprice`).
 */
export function totalsOf(
  files: Iterable<Pick<FileScan, "kind" | "buckets">>,
  table: PriceTable,
): UsageTotals {
  const totals: UsageTotals = {
    costUsd: 0,
    tokens: 0,
    cacheReadTokens: 0,
    agentCount: 0,
  };
  for (const file of files) {
    if (file.kind === "subagent") totals.agentCount += 1;
    for (const b of file.buckets) {
      totals.tokens +=
        tiered(b.input) +
        tiered(b.output) +
        tiered(b.cacheCreate5m) +
        tiered(b.cacheCreate1h);
      totals.cacheReadTokens += tiered(b.cacheRead);
      const priced = priceBucket(b, table);
      if (priced.ok) totals.costUsd += priced.cost;
    }
  }
  // Token counts are whole; the 5m / 1h cache-creation apportioning splits them
  // fractionally (see stats/cost's `buckets.ts`), so the sum carries float noise.
  totals.tokens = Math.round(totals.tokens);
  totals.cacheReadTokens = Math.round(totals.cacheReadTokens);
  return totals;
}
