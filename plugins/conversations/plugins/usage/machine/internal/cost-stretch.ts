import {
  emptyUsageBuckets,
  foldUsageEntry,
  type DayBucket,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";

// The pure half of the cost by the hour (`cost-by-hour.ts`): which lines
// of a conversation's transcripts carry usage, and the ledger's own fold
// (`foldUsageEntry`) over the ones written in a stretch of time — so the
// stretch is counted exactly as the sync counts it into the ledger: one entry
// per message, at its largest output, tiered per entry, cache writes split by
// TTL, deduped across the files of a resumed chain.

/** A transcript line that carries usage, as the fold reads it, with its instant. */
export interface UsageLine {
  /** The line's timestamp, epoch ms. */
  t: number;
  /** The fields `foldUsageEntry` reads, and nothing else (the memo holds these). */
  entry: {
    timestamp: string;
    requestId?: string;
    message: { id?: string; model?: string; usage: unknown };
  };
}

/**
 * The usage line `text` is, or null: not JSON (a torn or foreign line is the
 * transcript reader's to report), no usage, or no timestamp — a line with no
 * instant cannot be placed before or after a reading position.
 */
export function usageLineOf(text: string): UsageLine | null {
  // Most lines carry no usage: skip them before paying for the parse.
  if (!text.includes('"usage"')) return null;
  let line: unknown;
  try {
    line = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
  if (typeof line !== "object" || line === null) return null;
  const { timestamp, requestId, message } = line as Record<string, unknown>;
  if (typeof timestamp !== "string") return null;
  if (typeof message !== "object" || message === null) return null;
  const { id, model, usage } = message as Record<string, unknown>;
  if (typeof usage !== "object" || usage === null) return null;
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return null;
  return {
    t,
    entry: {
      timestamp,
      ...(typeof requestId === "string" ? { requestId } : {}),
      message: {
        ...(typeof id === "string" ? { id } : {}),
        ...(typeof model === "string" ? { model } : {}),
        usage,
      },
    },
  };
}

/** The conversation's cost once every usage line up to `t` (epoch ms) is counted. */
export interface CostStep {
  t: number;
  costUsd: number;
}

/** What one hour's stretch adds to the cost before it, line by line. */
export interface HourSteps {
  /** One per instant the cost moves, ascending — `before` plus the stretch so far. */
  steps: CostStep[];
  /** Each model with no price, at the first instant one of its lines is counted. */
  unpricedFrom: { model: string; t: number }[];
}

/**
 * The cost at every instant of `[from, to)` (epoch ms) a usage line moves it:
 * `before` plus the ledger's fold of the stretch's lines so far, each bucket
 * priced by `price` (null: no price — left out, its model named).
 *
 * The lines of every file are folded in time order (a stable sort, so lines of
 * one instant keep the order the sync reads the files in: the session chain,
 * oldest first, then the sub-agents) through ONE seen-set, so a resumed
 * session's copied history counts once. The lines before `from` are folded
 * first, unpriced, as the sync's seen-set has them: a message begun before the
 * hour and topped up inside it is the earlier hour's (the ledger files the
 * top-up there, so `before` holds it), never a new entry of this one. Only the
 * buckets the hour's own lines open are priced — a stretch holds a handful
 * (model × speed), each re-priced after each instant: O(lines × buckets).
 */
export function costSteps(
  files: readonly (readonly UsageLine[])[],
  from: number,
  to: number,
  before: number,
  price: (bucket: DayBucket) => number | null,
): HourSteps {
  const lines = files
    .flat()
    .filter((line) => line.t < to)
    .sort((a, b) => a.t - b.t);
  const fold = emptyUsageBuckets();
  let i = 0;
  for (; i < lines.length && lines[i]!.t < from; i++) {
    foldUsageEntry(fold, lines[i]!.entry);
  }
  // The earlier hours' buckets: a top-up lands in them, never in the cost here.
  const earlier = new Set(fold.buckets.keys());
  const steps: CostStep[] = [];
  const unpricedFrom: HourSteps["unpricedFrom"] = [];
  const unpriced = new Set<string>();
  let last = before;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    foldUsageEntry(fold, line.entry);
    // Every line of one instant is counted before the instant is priced.
    if (lines[i + 1]?.t === line.t) continue;
    let costUsd = before;
    for (const [key, bucket] of fold.buckets) {
      if (earlier.has(key)) continue;
      const cost = price(bucket);
      if (cost !== null) costUsd += cost;
      else if (!unpriced.has(bucket.model)) {
        unpriced.add(bucket.model);
        unpricedFrom.push({ model: bucket.model, t: line.t });
      }
    }
    if (costUsd !== last) steps.push({ t: line.t, costUsd });
    last = costUsd;
  }
  return { steps, unpricedFrom };
}
