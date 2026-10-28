import { TIER_THRESHOLD, type DayBucket, type TieredTokens } from "./buckets";

// ─── What this is ──────────────────────────────────────────────────────────────
//
// The ONE reading of a Claude Code transcript line's token usage: which lines
// count (ccusage's entry-hash dedup, each message at its largest output), how a counted entry's tokens are split
// (cache creation by TTL) and how they accumulate into the tier-decomposed
// `(date, model, speed)` buckets `priceBucket` prices. Pure and incremental — a
// fold over lines — so a whole-file parse (`parseTranscript`) and an append-only
// reader (conversations/usage) count and price a transcript identically.

interface RawEntry {
  timestamp?: string;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
      speed?: string | null;
    };
  };
}

/**
 * ccusage's `createUniqueHash` (`data-loader-9ESMosno.js:5570-5575`), inlined
 * verbatim so the serving path no longer imports `ccusage` at runtime (it stays
 * a dev-only dep for the verification script). `null` means "not dedupable" —
 * an entry missing either id is counted, exactly as ccusage does.
 */
function createUniqueHash(entry: RawEntry): string | null {
  const messageId = entry.message?.id;
  const requestId = entry.requestId;
  if (messageId == null || requestId == null) return null;
  return `${messageId}:${requestId}`;
}

/** `{below: min(t, 200k), above: max(0, t − 200k)}` accumulated into `acc`. */
function addTiered(acc: TieredTokens, t: number): void {
  acc.below += Math.min(t, TIER_THRESHOLD);
  acc.above += Math.max(0, t - TIER_THRESHOLD);
}

function emptyTiered(): TieredTokens {
  return { below: 0, above: 0 };
}

/**
 * `usage.speed` → the closed `DayBucket.speed` dimension. 28% of sampled entries
 * predate the field (absent/`null`), the rest are `"standard"`; none are
 * `"fast"` yet, so that arm is defensive rather than observed.
 *
 * An unrecognized value normalizes to `"standard"`: the union is closed by
 * `DayBucket`, and a genuinely new speed tier is a schema change (new arm +
 * `INDEX_VERSION` bump + a rate in `ModelPrice`), not something this parse can
 * represent.
 */
function normalizeSpeed(speed: string | null | undefined): "standard" | "fast" {
  return speed === "fast" ? "fast" : "standard";
}

/**
 * What the fold remembers of one counted entry: the bucket its tokens went to
 * (`null` when the entry had no day or model, so it reached no bucket) and the
 * output it counted — so a later line of the same message can top it up.
 */
export interface SeenEntry {
  bucket: string | null;
  output: number;
}

/**
 * A fold's running state: the `(date, model, speed)` buckets (keyed
 * `${date} ${model} ${speed}`) and the entries already counted, by hash.
 */
export interface UsageBuckets {
  buckets: Map<string, DayBucket>;
  seen: Map<string, SeenEntry>;
}

export function emptyUsageBuckets(): UsageBuckets {
  return { buckets: new Map(), seen: new Map() };
}

function bucketKey(b: Pick<DayBucket, "date" | "model" | "speed">): string {
  return `${b.date} ${b.model} ${b.speed}`;
}

/**
 * A fold resumed from stored state — the buckets an earlier fold produced and
 * the entries it had counted (both copied, so folding on cannot mutate them) —
 * so an append-only reader continues exactly where it stopped.
 */
export function resumeUsageBuckets(
  buckets: readonly DayBucket[],
  seen: Iterable<readonly [string, SeenEntry]>,
): UsageBuckets {
  return {
    buckets: new Map(buckets.map((b) => [bucketKey(b), structuredClone(b)])),
    seen: new Map([...seen].map(([hash, e]) => [hash, { ...e }])),
  };
}

/**
 * What one line added, as {@link foldUsageEntry} read it: a new entry's token
 * numbers (`kind: "entry"`), or — for a later line of a message already
 * counted, carrying more output (`kind: "top-up"`) — the output it adds, every
 * other number 0.
 */
export interface CountedUsage {
  kind: "entry" | "top-up";
  input: number;
  output: number;
  cacheRead: number;
  /** 5m + 1h combined. */
  cacheCreation: number;
  /** `YYYY-MM-DD`, or `""` when the entry has no timestamp. */
  day: string;
  model: string | undefined;
  /** The entry's dedup hash (`null` when it has none — counted every time). */
  hash: string | null;
}

/** `acc` with `from`'s per-entry tiering of `t` replaced by `to`'s. */
function retier(acc: TieredTokens, from: number, to: number): void {
  acc.below += Math.min(to, TIER_THRESHOLD) - Math.min(from, TIER_THRESHOLD);
  acc.above +=
    Math.max(0, to - TIER_THRESHOLD) - Math.max(0, from - TIER_THRESHOLD);
}

/**
 * Fold one parsed transcript line into `fold`. Returns what it added, or
 * `null` when the line carries no usage or repeats an entry already counted
 * (same `message.id` + `requestId`) without adding to it.
 *
 * Claude Code writes one line per content block of a message (a `thinking`
 * line, then a `text` or `tool_use` one), each with the message's `usage`:
 * input and cache counts are the same on every line, but `output_tokens` is
 * only final on the last — the first line of a thinking message can say 8 where
 * the last says 3,778. So an entry counts at its LARGEST output (ccusage's
 * reading too): a repeat with more output tops the counted entry up, in the
 * bucket the entry went to; nothing else of it is counted twice.
 */
export function foldUsageEntry(
  fold: UsageBuckets,
  line: unknown,
): CountedUsage | null {
  if (typeof line !== "object" || line === null) return null;
  const obj = line as RawEntry;
  const usage = obj.message?.usage;
  if (!usage) return null;

  const hash = createUniqueHash(obj);
  const output = usage.output_tokens ?? 0;
  const counted = hash == null ? undefined : fold.seen.get(hash);
  if (counted !== undefined) {
    if (output <= counted.output) return null;
    const bucket =
      counted.bucket === null ? undefined : fold.buckets.get(counted.bucket);
    // A bucket this fold does not hold — the entry was counted by an earlier
    // file of a chain re-read, whose buckets are that file's — keeps its count;
    // a copied history is copied whole, so its entry is already at its largest.
    if (bucket) retier(bucket.output, counted.output, output);
    const added = output - counted.output;
    counted.output = output;
    return {
      kind: "top-up",
      input: 0,
      output: added,
      cacheRead: 0,
      cacheCreation: 0,
      day: "",
      model: undefined,
      hash,
    };
  }

  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  // Cache creation splits by TTL, priced ~1.6× apart. `cache_creation` is
  // present on current transcripts and its two members sum exactly to
  // `cache_creation_input_tokens`; older entries predate the object, so all of
  // the scalar is attributed to 5m (the only rate that existed then).
  const create = usage.cache_creation;
  const cacheCreate5m = create
    ? (create.ephemeral_5m_input_tokens ?? 0)
    : (usage.cache_creation_input_tokens ?? 0);
  const cacheCreate1h = create ? (create.ephemeral_1h_input_tokens ?? 0) : 0;
  const cacheCreation = cacheCreate5m + cacheCreate1h;

  const day =
    typeof obj.timestamp === "string" ? obj.timestamp.slice(0, 10) : "";
  const model = obj.message?.model;
  const speed = normalizeSpeed(usage.speed);
  const key = day && model ? bucketKey({ date: day, model, speed }) : null;
  if (hash != null) fold.seen.set(hash, { bucket: key, output });

  if (key !== null && day && model) {
    const b = fold.buckets.get(key) ?? {
      date: day,
      model,
      speed,
      input: emptyTiered(),
      output: emptyTiered(),
      cacheRead: emptyTiered(),
      cacheCreate5m: emptyTiered(),
      cacheCreate1h: emptyTiered(),
    };
    // PER ENTRY, before aggregating — that is the whole point of the
    // decomposition (see `buckets.ts`). Aggregating first and tiering after
    // would charge the >200k rate to entries that never crossed it.
    addTiered(b.input, input);
    addTiered(b.output, output);
    addTiered(b.cacheRead, cacheRead);
    // The 200k tier is defined on the entry's COMBINED cache-creation count
    // (ccusage sees one `cache_creation_input_tokens` number), so the split
    // point is computed on the total and then apportioned across 5m/1h by
    // their share of it. Keeps the decomposition linear, and conserves exactly
    // (the 1h side takes the remainder rather than its own rounded product).
    const below = Math.min(cacheCreation, TIER_THRESHOLD);
    const above = Math.max(0, cacheCreation - TIER_THRESHOLD);
    const below5m =
      cacheCreation > 0 ? (below * cacheCreate5m) / cacheCreation : 0;
    const above5m =
      cacheCreation > 0 ? (above * cacheCreate5m) / cacheCreation : 0;
    b.cacheCreate5m.below += below5m;
    b.cacheCreate5m.above += above5m;
    b.cacheCreate1h.below += below - below5m;
    b.cacheCreate1h.above += above - above5m;
    fold.buckets.set(key, b);
  }

  return {
    kind: "entry",
    input,
    output,
    cacheRead,
    cacheCreation,
    day,
    model,
    hash,
  };
}
