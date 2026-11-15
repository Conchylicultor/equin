import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PriceTable, SeenEntry } from "@plugins/stats/plugins/cost/core";
import {
  advanceFile,
  isLegacyScan,
  priceFile,
  totalsOf,
  type FileScan,
} from "./scan";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
async function newDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "conversation-usage-"));
  dirs.push(dir);
  return dir;
}

/** One assistant transcript line; `block` repeats a message the way Claude Code
 *  writes one line per content block, all carrying the same id and usage. */
const line = (
  id: string,
  usage: { input?: number; output?: number; cacheRead?: number },
  requestId = `req-${id}`,
  timestamp = "2026-10-08T12:00:00.000Z",
) =>
  JSON.stringify({
    type: "assistant",
    timestamp,
    requestId,
    message: {
      role: "assistant",
      id,
      model: "claude-test",
      content: [],
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
      },
    },
  }) + "\n";

// $1 per input token, $2 per output token, $0.5 per cache-read token.
const TABLE: PriceTable = {
  fetchedAt: 0,
  models: {
    "claude-test": {
      input: 1,
      output: 2,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: 0.5,
    },
  },
};

const NO_PRICES: PriceTable = { fetchedAt: 0, models: {} };

/** The ledger hour of `line`'s default timestamp. */
const NOON = "2026-10-08T12:00:00.000Z";

/** Each scan priced whole with TABLE, then summed. */
const totals = (...scans: (FileScan | null)[]) =>
  totalsOf(
    scans
      .filter((s): s is FileScan => s !== null)
      .map((s) => ({ ...s, ...priceFile(undefined, s.buckets, TABLE) })),
  );

describe("advanceFile", () => {
  test("folds every complete line, then only what was appended", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(path, line("m1", { input: 1, output: 10 }));
    const first = await advanceFile(path, "session", undefined);
    expect(totals(first).tokens).toBe(11);

    await appendFile(path, line("m2", { input: 2, output: 5 }));
    const second = await advanceFile(path, "session", first!);
    expect(second!.offset).toBeGreaterThan(first!.offset);
    expect(totals(second)).toEqual({
      costUsd: 1 + 20 + 2 + 10,
      tokens: 18,
      cacheReadTokens: 0,
      agentCount: 0,
    });
  });

  test("returns the same scan when nothing was appended", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(path, line("m1", { output: 1 }));
    const first = await advanceFile(path, "session", undefined);
    expect(await advanceFile(path, "session", first!)).toBe(first!);
  });

  test("counts a message once across its block lines, even across a resume", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(path, line("m1", { output: 10 }));
    const first = await advanceFile(path, "session", undefined);
    // The next block line of the same message lands after the first read.
    await appendFile(path, line("m1", { output: 10 }));
    const second = await advanceFile(path, "session", first!);
    expect(totals(second).tokens).toBe(10);
  });

  test("counts a message at its last block's output, even across a resume", async () => {
    const path = join(await newDir(), "s.jsonl");
    // The thinking line carries a partial output; the text line the final one.
    await writeFile(path, line("m1", { input: 3, output: 8 }));
    const first = await advanceFile(path, "session", undefined);
    expect(totals(first).tokens).toBe(11);
    await appendFile(path, line("m1", { input: 3, output: 3778 }));
    const second = await advanceFile(path, "session", first!);
    expect(totals(second)).toEqual({
      costUsd: 3 + 2 * 3778,
      tokens: 3 + 3778,
      cacheReadTokens: 0,
      agentCount: 0,
    });
    // Priced incrementally from the first scan, the top-up is the only addition.
    const priced = priceFile(
      { ...first!, ...priceFile(undefined, first!.buckets, TABLE) },
      second!.buckets,
      TABLE,
    );
    expect(priced.costUsd).toBe(3 + 2 * 3778);
  });

  test("recounts a legacy scan (bare tail hashes) from the start", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(
      path,
      line("m1", { output: 8 }) + line("m1", { output: 3778 }),
    );
    // What the old fold stored: the first line's output, a bare hash.
    const current = await advanceFile(path, "session", undefined);
    const legacy: FileScan = {
      ...current!,
      buckets: current!.buckets.map((b) => ({
        ...b,
        output: { below: 8, above: 0 },
      })),
      tailHashes: ["m1:req-m1"],
    };
    expect(isLegacyScan(legacy)).toBe(true);
    const recounted = await advanceFile(path, "session", legacy);
    expect(isLegacyScan(recounted!)).toBe(false);
    expect(totals(recounted).tokens).toBe(3778);
  });

  test("drops a vanished legacy scan's tail, keeping its tokens", async () => {
    const path = join(await newDir(), "s.jsonl");
    const legacy: FileScan = {
      path,
      kind: "session",
      offset: 10,
      buckets: [],
      tailHashes: ["m1:req-m1"],
    };
    expect(await advanceFile(path, "session", legacy)).toEqual({
      ...legacy,
      tailHashes: [],
    });
  });

  test("leaves a torn last line for the next read", async () => {
    const path = join(await newDir(), "s.jsonl");
    const whole = line("m1", { output: 10 });
    await writeFile(path, whole.slice(0, 20));
    const torn = await advanceFile(path, "session", undefined);
    expect(torn!.offset).toBe(0);
    expect(totals(torn).tokens).toBe(0);

    await appendFile(path, whole.slice(20));
    const done = await advanceFile(path, "session", torn!);
    expect(totals(done).tokens).toBe(10);
  });

  test("starts over when the file shrank", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(
      path,
      line("m1", { output: 10 }) + line("m2", { output: 10 }),
    );
    const first = await advanceFile(path, "session", undefined);
    await writeFile(path, line("m3", { output: 3 }));
    const second = await advanceFile(path, "session", first!);
    expect(totals(second).tokens).toBe(3);
  });

  test("keeps a vanished file's scan, and skips one that never existed", async () => {
    const dir = await newDir();
    const path = join(dir, "s.jsonl");
    await writeFile(path, line("m1", { output: 10 }));
    const first = await advanceFile(path, "session", undefined);
    await rm(path);
    expect(await advanceFile(path, "session", first!)).toBe(first!);
    expect(
      await advanceFile(join(dir, "never.jsonl"), "session", undefined),
    ).toBeNull();
  });

  test("a chain re-read counts history a resumed session copied only once", async () => {
    const dir = await newDir();
    const older = join(dir, "a.jsonl");
    const newer = join(dir, "b.jsonl");
    await writeFile(older, line("m1", { output: 10 }));
    // The resumed session's file starts with the history it copied.
    await writeFile(
      newer,
      line("m1", { output: 10 }) + line("m2", { output: 4 }),
    );
    const seen = new Map<string, SeenEntry>();
    const a = await advanceFile(older, "session", undefined, seen);
    const b = await advanceFile(newer, "session", undefined, seen);
    expect(totals(a, b).tokens).toBe(14);
  });
});

describe("totalsOf", () => {
  test("counts sub-agents, keeps cache reads apart, and prices both", async () => {
    const dir = await newDir();
    const session = join(dir, "s.jsonl");
    const agent = join(dir, "agent-1.jsonl");
    await writeFile(session, line("m1", { input: 1, cacheRead: 100 }));
    await writeFile(agent, line("a1", { output: 5 }));
    const result = totals(
      await advanceFile(session, "session", undefined),
      await advanceFile(agent, "subagent", undefined),
    );
    expect(result).toEqual({
      costUsd: 1 + 50 + 10,
      tokens: 6,
      cacheReadTokens: 100,
      agentCount: 1,
    });
  });

  test("an unpriced model adds tokens but no cost", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(path, line("m1", { output: 5 }));
    const scan = await advanceFile(path, "session", undefined);
    const pricing = priceFile(undefined, scan!.buckets, NO_PRICES);
    expect(pricing).toEqual({
      costUsd: 0,
      unpricedModels: ["claude-test"],
      addedByHour: new Map(),
    });
    const result = totalsOf([{ ...scan!, ...pricing }]);
    expect(result.tokens).toBe(5);
    expect(result.costUsd).toBe(0);
  });
});

describe("priceFile", () => {
  test("keeps what was priced, and prices only what was appended", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(path, line("m1", { input: 1, output: 10 }));
    const first = await advanceFile(path, "session", undefined);
    const firstPricing = priceFile(undefined, first!.buckets, TABLE);
    expect(firstPricing.costUsd).toBe(21);
    expect(firstPricing.addedByHour).toEqual(new Map([[NOON, 21]]));

    // The price doubles; the tokens already counted keep their cost.
    const doubled: PriceTable = {
      fetchedAt: 1,
      models: {
        "claude-test": { ...TABLE.models["claude-test"]!, input: 2, output: 4 },
      },
    };
    const stored = { ...first!, ...firstPricing };
    // Nothing new counted: nothing added, whatever the table says now.
    expect(priceFile(stored, first!.buckets, doubled)).toEqual({
      ...firstPricing,
      addedByHour: new Map(),
    });

    await appendFile(path, line("m2", { input: 2, output: 5 }));
    const second = await advanceFile(path, "session", first!);
    expect(priceFile(stored, second!.buckets, doubled)).toEqual({
      costUsd: 21 + 2 * 2 + 5 * 4,
      unpricedModels: [],
      // Only the appended message, filed under its own bucket's hour.
      addedByHour: new Map([[NOON, 2 * 2 + 5 * 4]]),
    });
  });

  test("prices an unpriced model once the table knows it", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(path, line("m1", { output: 5 }));
    const scan = await advanceFile(path, "session", undefined);
    const unpriced = {
      ...scan!,
      ...priceFile(undefined, scan!.buckets, NO_PRICES),
    };
    expect(priceFile(unpriced, scan!.buckets, NO_PRICES)).toEqual({
      costUsd: 0,
      unpricedModels: ["claude-test"],
      addedByHour: new Map(),
    });
    // Priced now: added on this pass, filed under the hour it was spent in.
    expect(priceFile(unpriced, scan!.buckets, TABLE)).toEqual({
      costUsd: 10,
      unpricedModels: [],
      addedByHour: new Map([[NOON, 10]]),
    });
  });

  test("a model with no tokens is never left unpriced", () => {
    const zero = { below: 0, above: 0 };
    const synthetic = {
      date: "2026-10-08",
      model: "<synthetic>",
      speed: "standard" as const,
      input: zero,
      output: zero,
      cacheRead: zero,
      cacheCreate5m: zero,
      cacheCreate1h: zero,
    };
    expect(priceFile(undefined, [synthetic], TABLE)).toEqual({
      costUsd: 0,
      unpricedModels: [],
      addedByHour: new Map(),
    });
  });

  test("a row never priced is priced whole", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(path, line("m1", { input: 3 }));
    const scan = await advanceFile(path, "session", undefined);
    const legacy = { ...scan!, costUsd: null, unpricedModels: [] };
    expect(priceFile(legacy, scan!.buckets, TABLE).costUsd).toBe(3);
  });

  test("files each hour's cost under its own hour, across an hour boundary", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(
      path,
      line("m1", { input: 1 }, "r1", "2026-10-08T12:59:59.000Z") +
        line("m2", { input: 2 }, "r2", "2026-10-08T13:00:00.000Z"),
    );
    const first = await advanceFile(path, "session", undefined);
    expect(first!.buckets.map((b) => b.hour).sort()).toEqual([12, 13]);
    const firstPricing = priceFile(undefined, first!.buckets, TABLE);
    expect(firstPricing.addedByHour).toEqual(
      new Map([
        ["2026-10-08T12:00:00.000Z", 1],
        ["2026-10-08T13:00:00.000Z", 2],
      ]),
    );

    // An append in the next day's first hour adds there alone.
    await appendFile(
      path,
      line("m3", { output: 1 }, "r3", "2026-10-09T00:10:00.000Z"),
    );
    const second = await advanceFile(path, "session", first!);
    const pass = priceFile(
      { ...first!, ...firstPricing },
      second!.buckets,
      TABLE,
    );
    expect(pass.addedByHour).toEqual(
      new Map([["2026-10-09T00:00:00.000Z", 2]]),
    );
    expect(pass.costUsd).toBe(5);
  });

  test("a day bucket counted before hours is re-bucketed, not re-filed", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(
      path,
      line("m1", { input: 1 }, "r1", "2026-10-08T09:00:00.000Z") +
        line("m2", { input: 2 }, "r2", "2026-10-08T10:30:00.000Z"),
    );
    const hourly = await advanceFile(path, "session", undefined);
    // What a row counted before hours held: one day bucket, both messages.
    const legacy = {
      ...hourly!,
      buckets: [
        {
          ...hourly!.buckets[0]!,
          hour: undefined,
          input: { below: 3, above: 0 },
        },
      ],
      costUsd: 3,
      unpricedModels: [],
    };
    // A re-read from the start re-buckets the same tokens by hour: nothing
    // was spent on this pass.
    const reread = priceFile(legacy, hourly!.buckets, TABLE);
    expect(reread.costUsd).toBe(3);
    expect(reread.addedByHour).toEqual(new Map());

    // A message appended before the re-read is the only cost, at its hour.
    await appendFile(
      path,
      line("m3", { input: 4 }, "r3", "2026-10-08T11:00:00.000Z"),
    );
    const grown = await advanceFile(path, "session", undefined);
    const pass = priceFile(legacy, grown!.buckets, TABLE);
    expect(pass.costUsd).toBe(7);
    expect(pass.addedByHour).toEqual(
      new Map([["2026-10-08T11:00:00.000Z", 4]]),
    );
  });
});
