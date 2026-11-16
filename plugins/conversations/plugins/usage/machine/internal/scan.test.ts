import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeenEntry } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import {
  advanceFile,
  agentCountOf,
  isLegacyScan,
  scanTranscript,
  tokenDelta,
  type FileScan,
} from "./scan";
import type { DayBucket } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";

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

const tiered = (t: { below: number; above: number }): number =>
  t.below + t.above;

/** The scans' tokens summed: everything but cache reads, and cache reads apart. */
const totals = (...scans: (FileScan | null)[]) => {
  let tokens = 0;
  let cacheReadTokens = 0;
  for (const scan of scans) {
    for (const b of scan?.buckets ?? []) {
      tokens +=
        tiered(b.input) +
        tiered(b.output) +
        tiered(b.cacheCreate5m) +
        tiered(b.cacheCreate1h);
      cacheReadTokens += tiered(b.cacheRead);
    }
  }
  return { tokens: Math.round(tokens), cacheReadTokens };
};

describe("advanceFile", () => {
  test("folds every complete line, then only what was appended", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(path, line("m1", { input: 1, output: 10 }));
    const first = await advanceFile(path, "session", undefined);
    expect(totals(first).tokens).toBe(11);

    await appendFile(path, line("m2", { input: 2, output: 5 }));
    const second = await advanceFile(path, "session", first!);
    expect(second!.offset).toBeGreaterThan(first!.offset);
    expect(totals(second)).toEqual({ tokens: 18, cacheReadTokens: 0 });
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
    expect(totals(second)).toEqual({ tokens: 3 + 3778, cacheReadTokens: 0 });
    // Taken from the first scan, the top-up is the only addition.
    const delta = tokenDelta(first!.buckets, second!.buckets);
    expect(delta.map((b) => tiered(b.output))).toEqual([3778 - 8]);
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

describe("agentCountOf", () => {
  test("counts sub-agents, keeping cache reads apart in the tokens", async () => {
    const dir = await newDir();
    const session = join(dir, "s.jsonl");
    const agent = join(dir, "agent-1.jsonl");
    await writeFile(session, line("m1", { input: 1, cacheRead: 100 }));
    await writeFile(agent, line("a1", { output: 5 }));
    const scans = [
      await advanceFile(session, "session", undefined),
      await advanceFile(agent, "subagent", undefined),
    ];
    expect(agentCountOf(scans.filter((s) => s !== null))).toBe(1);
    expect(totals(...scans)).toEqual({ tokens: 6, cacheReadTokens: 100 });
  });
});

describe("tokenDelta", () => {
  const t = (below: number) => ({ below, above: 0 });
  const bucket = (hour: number, input: number, create5m = 0): DayBucket => ({
    date: "2026-10-08",
    hour,
    model: "model-a",
    speed: "standard",
    input: t(input),
    output: t(0),
    cacheRead: t(0),
    cacheCreate5m: t(create5m),
    cacheCreate1h: t(0),
  });

  test("the tokens counted since the last write, unmoved buckets dropped", () => {
    const delta = tokenDelta(
      [bucket(10, 100)],
      [bucket(10, 100), bucket(11, 40)],
    );
    expect(delta.map((b) => [b.hour, b.input.below])).toEqual([[11, 40]]);
  });

  test("a bucket a re-read took back is a negative delta", () => {
    const delta = tokenDelta(
      [bucket(10, 100), bucket(11, 40)],
      [bucket(10, 70)],
    );
    expect(delta.map((b) => [b.hour, b.input.below])).toEqual([
      [10, -30],
      [11, -40],
    ]);
  });

  test("whole tokens whose deltas add up to the rounded total", () => {
    const steps = [bucket(10, 0, 0.4), bucket(10, 0, 1.2), bucket(10, 0, 2.6)];
    let sum = 0;
    let prev: DayBucket[] | undefined;
    for (const next of steps) {
      for (const d of tokenDelta(prev, [next])) {
        expect(Number.isInteger(d.cacheCreate5m.below)).toBe(true);
        sum += d.cacheCreate5m.below;
      }
      prev = [next];
    }
    expect(sum).toBe(3);
  });
});

describe("scanTranscript", () => {
  /** A read's counted input / output, summed over its buckets. */
  const sums = (read: Awaited<ReturnType<typeof scanTranscript>>) => {
    if (read.status !== "read") throw new Error(`not a read: ${read.status}`);
    let input = 0;
    let output = 0;
    for (const b of read.counted) {
      input += b.input.below + b.input.above;
      output += b.output.below + b.output.above;
    }
    return { input, output };
  };

  test("files each read's delta only — a top-up across appends included", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(path, line("m1", { input: 3, output: 8 }));
    const first = await scanTranscript(path, "session", undefined);
    expect(sums(first)).toEqual({ input: 3, output: 8 });
    if (first.status !== "read") throw new Error("unreachable");

    // The same message's final line, and a new message, after the first read.
    await appendFile(path, line("m1", { input: 3, output: 3778 }));
    await appendFile(path, line("m2", { input: 1, output: 1 }));
    const second = await scanTranscript(path, "session", first.scan);
    expect(sums(second)).toEqual({ input: 1, output: 3770 + 1 });
    if (second.status !== "read") throw new Error("unreachable");
    expect(second.scan.offset).toBeGreaterThan(first.scan.offset);
    // Every delta is on the line's own hour.
    expect(second.counted.map((b) => `${b.date}T${b.hour}`)).toEqual([
      "2026-10-08T12",
    ]);

    expect(await scanTranscript(path, "session", second.scan)).toEqual({
      status: "unchanged",
    });
  });

  test("a repeated block line adds nothing", async () => {
    const path = join(await newDir(), "s.jsonl");
    await writeFile(path, line("m1", { output: 10 }));
    const first = await scanTranscript(path, "session", undefined);
    if (first.status !== "read") throw new Error("unreachable");
    await appendFile(path, line("m1", { output: 10 }));
    const second = await scanTranscript(path, "session", first.scan);
    expect(second.status === "read" && second.counted).toEqual([]);
  });

  test("a torn last line waits for its newline", async () => {
    const path = join(await newDir(), "s.jsonl");
    const full = line("m1", { input: 4 });
    await writeFile(path, full.slice(0, 20));
    const torn = await scanTranscript(path, "session", undefined);
    if (torn.status !== "read") throw new Error("unreachable");
    expect(torn.scan.offset).toBe(0);
    expect(torn.counted).toEqual([]);
    await appendFile(path, full.slice(20));
    expect(sums(await scanTranscript(path, "session", torn.scan))).toEqual({
      input: 4,
      output: 0,
    });
  });

  test("a file shorter than was read, or gone, is reported — never re-read as new", async () => {
    const dir = await newDir();
    const path = join(dir, "s.jsonl");
    await writeFile(path, line("m1", { input: 1 }) + line("m2", { input: 2 }));
    const first = await scanTranscript(path, "session", undefined);
    if (first.status !== "read") throw new Error("unreachable");
    await writeFile(path, line("m1", { input: 1 }));
    expect(await scanTranscript(path, "session", first.scan)).toEqual({
      status: "shrunk",
    });
    await rm(path);
    expect(await scanTranscript(path, "session", first.scan)).toEqual({
      status: "gone",
    });
  });
});
