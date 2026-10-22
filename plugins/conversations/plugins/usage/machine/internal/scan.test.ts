import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PriceTable } from "@plugins/stats/plugins/cost/core";
import { advanceFile, totalsOf, type FileScan } from "./scan";

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
) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-08T12:00:00.000Z",
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

const totals = (...scans: (FileScan | null)[]) =>
  totalsOf(
    scans.filter((s): s is FileScan => s !== null),
    TABLE,
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
    const seen = new Set<string>();
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
    const result = totalsOf([scan!], { fetchedAt: 0, models: {} });
    expect(result.tokens).toBe(5);
    expect(result.costUsd).toBe(0);
  });
});
