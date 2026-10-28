import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIER_THRESHOLD } from "../../core/buckets";
import type { PriceTable } from "../../core/pricing";
import { parseTranscript, rollup, type FilePartial } from "./usage-index";

// ─── Fixture ─────────────────────────────────────────────────────────────────
// A tiny `projects/<dir>/<session>.jsonl` tree, standing in for ~/.claude/projects
// so the test never touches the real corpus. The generic incremental index
// mechanics (enumerate / fingerprint-diff / persist / drop-vanished) are covered
// by `infra/corpus-index`'s own test; here we cover the COST-SPECIFIC halves:
// the tier-decomposing token parse (`parseTranscript`) and the exact per-bucket
// pricing rollup (`rollup`).

let root: string;
let projectsRoot: string;

const ALPHA = "-Users-me-proj-alpha";
const BETA = "-Users-me-proj-beta";

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  speed?: string | null;
}

function line(
  reqId: string,
  msgId: string,
  model: string,
  day: string,
  usage: Usage,
): string {
  return (
    JSON.stringify({
      timestamp: `${day}T10:00:00Z`,
      requestId: reqId,
      message: { id: msgId, model, usage },
    }) + "\n"
  );
}

function entry(
  reqId: string,
  msgId: string,
  model: string,
  day: string,
  io: [number, number],
) {
  return line(reqId, msgId, model, day, {
    input_tokens: io[0],
    output_tokens: io[1],
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
}

// ─── Hand-built price table ──────────────────────────────────────────────────
// Deliberately hand-written rather than derived from the vendored snapshot: the
// tests below assert EXACT arithmetic, so the rates have to be visible right
// here. `model-tiered` is the only model with `*Above200k` rates — that is the
// case the below/above decomposition exists for.

const TABLE: PriceTable = {
  fetchedAt: 0,
  models: {
    "model-tiered": {
      input: 3e-6,
      output: 15e-6,
      cacheCreate5m: 3.75e-6,
      cacheCreate1h: 6e-6,
      cacheRead: 3e-7,
      inputAbove200k: 6e-6,
      outputAbove200k: 22.5e-6,
      cacheCreate5mAbove200k: 7.5e-6,
      cacheCreate1hAbove200k: 12e-6,
      cacheReadAbove200k: 6e-7,
    },
    "model-flat": {
      input: 1e-6,
      output: 2e-6,
      cacheCreate5m: 1.25e-6,
      cacheCreate1h: 2e-6,
      cacheRead: 1e-7,
    },
  },
};

// A table with NO substring-resolvable models at all, so an unknown model really
// misses (`resolveModel`'s last resort is a two-way substring match).
const EMPTY_TABLE: PriceTable = { fetchedAt: 0, models: {} };

// Build the entries map (path → FilePartial) the way `corpusIndex.entries()`
// would, by parsing every fixture file through the cost parse.
async function buildEntries(): Promise<Map<string, FilePartial>> {
  const paths = [
    join(projectsRoot, ALPHA, "sess-1111.jsonl"),
    join(projectsRoot, ALPHA, "sess-2222.jsonl"),
    join(projectsRoot, BETA, "sess-3333.jsonl"),
  ];
  const out = new Map<string, FilePartial>();
  for (const p of paths) out.set(p, await parseTranscript(p));
  return out;
}

/** Parse a one-off transcript written into the fixture root under `name`. */
async function parseInline(name: string, body: string): Promise<FilePartial> {
  const dir = join(projectsRoot, ALPHA);
  const path = join(dir, `${name}.jsonl`);
  await writeFile(path, body);
  return parseTranscript(path);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cost-usage-test-"));
  projectsRoot = join(root, "projects");
  await mkdir(join(projectsRoot, ALPHA), { recursive: true });
  await mkdir(join(projectsRoot, BETA), { recursive: true });
  await writeFile(
    join(projectsRoot, ALPHA, "sess-1111.jsonl"),
    entry("r1", "m1", "model-flat", "2026-07-01", [1000, 500]) +
      entry("r2", "m2", "model-flat", "2026-07-01", [100, 50]),
  );
  await writeFile(
    join(projectsRoot, ALPHA, "sess-2222.jsonl"),
    entry("r3", "m3", "model-tiered", "2026-07-02", [10, 5]),
  );
  await writeFile(
    join(projectsRoot, BETA, "sess-3333.jsonl"),
    entry("r4", "m4", "model-flat", "2026-07-03", [5000, 2000]),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// ─── parseTranscript ─────────────────────────────────────────────────────────

test("parseTranscript sums tokens, derives session/project from the path, and dedups by hash", async () => {
  const p = join(projectsRoot, ALPHA, "sess-1111.jsonl");
  const partial = await parseTranscript(p);
  expect(partial.sessionId).toBe("sess-1111");
  expect(partial.projectDir).toBe(ALPHA);
  expect(partial.inputTokens).toBe(1000 + 100);
  expect(partial.outputTokens).toBe(500 + 50);
  expect(partial.totalTokens).toBe(1000 + 100 + 500 + 50);
  expect(partial.lastActivity).toBe("2026-07-01");
  expect(partial.modelsUsed).toEqual(["model-flat"]);
});

test("parseTranscript dedups repeated (messageId, requestId) pairs within a file", async () => {
  const partial = await parseInline(
    "dedup",
    entry("r1", "m1", "model-flat", "2026-07-01", [100, 10]) +
      entry("r1", "m1", "model-flat", "2026-07-01", [100, 10]) +
      // Same message id, different request id → a distinct entry, counted.
      entry("r2", "m1", "model-flat", "2026-07-01", [100, 10]),
  );
  expect(partial.inputTokens).toBe(200);
  expect(partial.outputTokens).toBe(20);
});

test("parseTranscript counts a multi-block message at its largest output", async () => {
  // Claude Code writes one line per content block; only the last line's
  // output_tokens is final (the thinking line's is partial).
  const partial = await parseInline(
    "multi-block",
    entry("r1", "m1", "model-flat", "2026-07-01", [100, 8]) +
      entry("r1", "m1", "model-flat", "2026-07-01", [100, 3778]) +
      // A later line with LESS output adds nothing.
      entry("r1", "m1", "model-flat", "2026-07-01", [100, 50]),
  );
  expect(partial.inputTokens).toBe(100);
  expect(partial.outputTokens).toBe(3778);
  expect(partial.dayBuckets).toHaveLength(1);
  expect(partial.dayBuckets[0]!.output).toEqual({ below: 3778, above: 0 });
  expect(partial.dayBuckets[0]!.input).toEqual({ below: 100, above: 0 });
});

test('speed normalizes absent / null / "standard" to standard, and "fast" through', async () => {
  const partial = await parseInline(
    "speed",
    line("r1", "m1", "model-flat", "2026-07-01", { input_tokens: 10 }) +
      line("r2", "m2", "model-flat", "2026-07-01", {
        input_tokens: 10,
        speed: null,
      }) +
      line("r3", "m3", "model-flat", "2026-07-01", {
        input_tokens: 10,
        speed: "standard",
      }),
  );
  // All three collapse into ONE bucket — the key dimension is normalized, not raw.
  expect(partial.dayBuckets).toHaveLength(1);
  expect(partial.dayBuckets[0]!.speed).toBe("standard");
  expect(partial.dayBuckets[0]!.input.below).toBe(30);

  const fast = await parseInline(
    "speed-fast",
    line("r1", "m1", "model-flat", "2026-07-01", {
      input_tokens: 10,
      speed: "standard",
    }) +
      line("r2", "m2", "model-flat", "2026-07-01", {
        input_tokens: 10,
        speed: "fast",
      }),
  );
  // Different speeds are different buckets (the multiplier is a whole-entry scalar).
  expect(fast.dayBuckets.map((b) => b.speed).sort()).toEqual([
    "fast",
    "standard",
  ]);
});

test("an entry above the 200k threshold splits into below/above and prices at both rates", async () => {
  const cacheRead = TIER_THRESHOLD + 50_000;
  const partial = await parseInline(
    "big-cache-read",
    line("r1", "m1", "model-tiered", "2026-07-05", {
      cache_read_input_tokens: cacheRead,
    }),
  );
  const b = partial.dayBuckets[0]!;
  expect(b.cacheRead.below).toBe(TIER_THRESHOLD);
  expect(b.cacheRead.above).toBe(50_000);

  const { sessions } = rollup(new Map([["p", partial]]), TABLE);
  const price = TABLE.models["model-tiered"]!;
  const expected =
    TIER_THRESHOLD * price.cacheRead + 50_000 * price.cacheReadAbove200k!;
  expect(sessions[0]!.cost).toBeCloseTo(expected, 12);
});

test("tiering is per ENTRY: two entries of one (date, model) are not tiered on their sum", async () => {
  // One entry crosses the threshold, one does not. Aggregating first (300k total)
  // and tiering after would charge the >200k rate to 100k tokens that never left
  // the base tier — the exact bug the below/above decomposition prevents.
  const big = TIER_THRESHOLD + 50_000;
  const small = 50_000;
  const partial = await parseInline(
    "per-entry-tier",
    line("r1", "m1", "model-tiered", "2026-07-06", { input_tokens: big }) +
      line("r2", "m2", "model-tiered", "2026-07-06", { input_tokens: small }),
  );
  const b = partial.dayBuckets[0]!;
  expect(b.input.below).toBe(TIER_THRESHOLD + small);
  expect(b.input.above).toBe(50_000);

  const price = TABLE.models["model-tiered"]!;
  const { sessions } = rollup(new Map([["p", partial]]), TABLE);
  const perEntry =
    TIER_THRESHOLD * price.input +
    50_000 * price.inputAbove200k! +
    small * price.input;
  expect(sessions[0]!.cost).toBeCloseTo(perEntry, 12);

  // …and that answer really differs from the aggregate-then-tier one.
  const total = big + small;
  const aggregateThenTier =
    TIER_THRESHOLD * price.input +
    (total - TIER_THRESHOLD) * price.inputAbove200k!;
  expect(aggregateThenTier).toBeGreaterThan(perEntry);
});

test("1h cache creation is priced at the 1h rate, not the 5m rate", async () => {
  const partial = await parseInline(
    "cache-1h",
    line("r1", "m1", "model-tiered", "2026-07-07", {
      cache_creation_input_tokens: 10_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 4_000,
        ephemeral_1h_input_tokens: 6_000,
      },
    }),
  );
  const b = partial.dayBuckets[0]!;
  expect(b.cacheCreate5m).toEqual({ below: 4_000, above: 0 });
  expect(b.cacheCreate1h).toEqual({ below: 6_000, above: 0 });
  // The scalar total stays the combined count (`handleTokenMix` reads it).
  expect(partial.cacheCreationTokens).toBe(10_000);

  const price = TABLE.models["model-tiered"]!;
  const { sessions } = rollup(new Map([["p", partial]]), TABLE);
  expect(sessions[0]!.cost).toBeCloseTo(
    4_000 * price.cacheCreate5m + 6_000 * price.cacheCreate1h,
    12,
  );
  // ccusage's answer (everything at the 5m rate) is strictly lower — this is the
  // deliberate +8.1% divergence.
  expect(sessions[0]!.cost).toBeGreaterThan(10_000 * price.cacheCreate5m);
});

test("an entry with no cache_creation object attributes the whole scalar to 5m", async () => {
  const partial = await parseInline(
    "cache-legacy",
    line("r1", "m1", "model-tiered", "2026-07-08", {
      cache_creation_input_tokens: 7_777,
    }),
  );
  const b = partial.dayBuckets[0]!;
  expect(b.cacheCreate5m).toEqual({ below: 7_777, above: 0 });
  expect(b.cacheCreate1h).toEqual({ below: 0, above: 0 });
  expect(partial.cacheCreationTokens).toBe(7_777);
});

test("the 200k threshold is apportioned across 5m/1h by their share of the combined count", async () => {
  // Combined 400k = 100k 5m + 300k 1h. The tier splits the COMBINED count
  // (200k below / 200k above), then each half is apportioned 25% / 75%.
  const c5m = 100_000;
  const c1h = 300_000;
  const combined = c5m + c1h;
  const partial = await parseInline(
    "cache-apportion",
    line("r1", "m1", "model-tiered", "2026-07-09", {
      cache_creation_input_tokens: combined,
      cache_creation: {
        ephemeral_5m_input_tokens: c5m,
        ephemeral_1h_input_tokens: c1h,
      },
    }),
  );
  const b = partial.dayBuckets[0]!;
  expect(b.cacheCreate5m.below).toBeCloseTo(TIER_THRESHOLD * 0.25, 6);
  expect(b.cacheCreate5m.above).toBeCloseTo(TIER_THRESHOLD * 0.25, 6);
  expect(b.cacheCreate1h.below).toBeCloseTo(TIER_THRESHOLD * 0.75, 6);
  expect(b.cacheCreate1h.above).toBeCloseTo(TIER_THRESHOLD * 0.75, 6);
  // Conserves exactly: nothing is created or lost by the apportioning.
  expect(
    b.cacheCreate5m.below +
      b.cacheCreate5m.above +
      b.cacheCreate1h.below +
      b.cacheCreate1h.above,
  ).toBeCloseTo(combined, 6);

  const price = TABLE.models["model-tiered"]!;
  const { sessions } = rollup(new Map([["p", partial]]), TABLE);
  const expected =
    TIER_THRESHOLD * 0.25 * price.cacheCreate5m +
    TIER_THRESHOLD * 0.25 * price.cacheCreate5mAbove200k! +
    TIER_THRESHOLD * 0.75 * price.cacheCreate1h +
    TIER_THRESHOLD * 0.75 * price.cacheCreate1hAbove200k!;
  expect(sessions[0]!.cost).toBeCloseTo(expected, 12);
});

// ─── rollup ──────────────────────────────────────────────────────────────────

test("each session gets its OWN exact cost, not a token-share split of a project total", async () => {
  const entries = await buildEntries();
  const { daily, sessions, unpriced } = rollup(entries, TABLE);
  expect(unpriced).toEqual([]);

  const flat = TABLE.models["model-flat"]!;
  const tiered = TABLE.models["model-tiered"]!;

  // ALPHA's two sessions have wildly different token counts (1650 vs 15) AND
  // different models. Each is priced from its own buckets — a token-share split
  // of a project total could not produce these two numbers.
  const s1 = sessions.find((s) => s.sessionId === "sess-1111")!;
  const s2 = sessions.find((s) => s.sessionId === "sess-2222")!;
  const s3 = sessions.find((s) => s.sessionId === "sess-3333")!;
  expect(s1.cost).toBeCloseTo(1100 * flat.input + 550 * flat.output, 12);
  expect(s2.cost).toBeCloseTo(10 * tiered.input + 5 * tiered.output, 12);
  expect(s3.cost).toBeCloseTo(5000 * flat.input + 2000 * flat.output, 12);

  // Daily totals are the same sums regrouped — no redistribution anywhere.
  const total = sessions.reduce((a, s) => a + s.cost, 0);
  expect(daily.reduce((a, r) => a + r.totalCost, 0)).toBeCloseTo(total, 12);

  const alphaDay1 = daily.find(
    (r) => r.date === "2026-07-01" && r.project === ALPHA,
  )!;
  expect(alphaDay1.inputTokens).toBe(1100);
  expect(alphaDay1.outputTokens).toBe(550);
  expect(alphaDay1.modelBreakdowns).toEqual([
    { modelName: "model-flat", cost: alphaDay1.totalCost },
  ]);
});

test("modelBreakdowns split a day's cost per model, exactly", async () => {
  const partial = await parseInline(
    "two-models",
    line("r1", "m1", "model-flat", "2026-07-10", { input_tokens: 1000 }) +
      line("r2", "m2", "model-tiered", "2026-07-10", { input_tokens: 1000 }),
  );
  const { daily } = rollup(new Map([["p", partial]]), TABLE);
  expect(daily).toHaveLength(1);
  const byModel = new Map(
    daily[0]!.modelBreakdowns.map((m) => [m.modelName, m.cost]),
  );
  expect(byModel.get("model-flat")).toBeCloseTo(
    1000 * TABLE.models["model-flat"]!.input,
    12,
  );
  expect(byModel.get("model-tiered")).toBeCloseTo(
    1000 * TABLE.models["model-tiered"]!.input,
    12,
  );
  expect(daily[0]!.totalCost).toBeCloseTo(
    (byModel.get("model-flat") ?? 0) + (byModel.get("model-tiered") ?? 0),
    12,
  );
});

test("DailyRow.cacheCreationTokens is 5m + 1h combined", async () => {
  const partial = await parseInline(
    "daily-cache-combined",
    line("r1", "m1", "model-tiered", "2026-07-11", {
      cache_creation_input_tokens: 900,
      cache_creation: {
        ephemeral_5m_input_tokens: 400,
        ephemeral_1h_input_tokens: 500,
      },
    }),
  );
  const { daily } = rollup(new Map([["p", partial]]), TABLE);
  expect(daily[0]!.cacheCreationTokens).toBe(900);
});

test("an unknown model surfaces in `unpriced` with summed tokens and adds no silent $0", async () => {
  const partial = await parseInline(
    "unknown-model",
    line("r1", "m1", "ghost-model", "2026-07-12", {
      input_tokens: 100,
      output_tokens: 20,
    }) +
      line("r2", "m2", "ghost-model", "2026-07-13", {
        input_tokens: 5,
        output_tokens: 1,
      }),
  );
  const { sessions, daily, unpriced } = rollup(
    new Map([["p", partial]]),
    EMPTY_TABLE,
  );

  // Deduped by model, tokens summed across both buckets.
  expect(unpriced).toEqual([{ model: "ghost-model", tokens: 126 }]);

  // The cost really is 0 — but only because the caller was TOLD. The tokens are
  // still visible in the rows, so a $0 total next to 126 tokens is loud, not silent.
  expect(sessions[0]!.cost).toBe(0);
  expect(daily.reduce((a, r) => a + r.totalCost, 0)).toBe(0);
  expect(daily.reduce((a, r) => a + r.inputTokens, 0)).toBe(105);
});

test("unpriced is empty when every bucket resolves", async () => {
  const entries = await buildEntries();
  expect(rollup(entries, TABLE).unpriced).toEqual([]);
});
