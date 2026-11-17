import { describe, expect, test } from "bun:test";
import { foldStretch, usageLineOf } from "./cost-stretch";

const line = (
  timestamp: string,
  id: string,
  output: number,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    type: "assistant",
    timestamp,
    requestId: `req-${id}`,
    message: {
      id,
      model: "test-model",
      usage: { input_tokens: 10, output_tokens: output },
    },
    ...extra,
  });

describe("usageLineOf", () => {
  test("reads a usage line, skips the rest", () => {
    expect(usageLineOf(line("2026-11-17T10:05:00.000Z", "m1", 5))?.t).toBe(
      Date.parse("2026-11-17T10:05:00.000Z"),
    );
    expect(usageLineOf('{"type":"user","message":{"content":"x"}}')).toBeNull();
    expect(usageLineOf('{"usage": torn')).toBeNull();
    expect(
      usageLineOf(JSON.stringify({ message: { usage: { output_tokens: 1 } } })),
    ).toBeNull();
  });
});

describe("foldStretch", () => {
  const parse = (...texts: string[]) =>
    texts.map((t) => {
      const l = usageLineOf(t);
      if (!l) throw new Error(`not a usage line: ${t}`);
      return l;
    });
  const from = Date.parse("2026-11-17T10:00:00.000Z");

  test("counts only the lines in the stretch", () => {
    const main = parse(
      line("2026-11-17T09:59:59.000Z", "m0", 100),
      line("2026-11-17T10:01:00.000Z", "m1", 7),
      line("2026-11-17T10:30:00.000Z", "m2", 1000),
    );
    const fold = foldStretch(
      [main],
      from,
      Date.parse("2026-11-17T10:10:00.000Z"),
    );
    const [bucket] = [...fold.buckets.values()];
    expect(fold.buckets.size).toBe(1);
    expect(bucket?.output.below).toBe(7);
    expect(bucket?.input.below).toBe(10);
  });

  test("a sub-agent's lines count by their own instants, a copied line once", () => {
    const first = parse(line("2026-11-17T10:01:00.000Z", "m1", 7));
    // A resumed session's file copies the history before it.
    const resumed = parse(
      line("2026-11-17T10:01:00.000Z", "m1", 7),
      line("2026-11-17T10:20:00.000Z", "m3", 2),
    );
    const agent = parse(line("2026-11-17T10:05:00.000Z", "a1", 30));
    const fold = foldStretch(
      [first, resumed, agent],
      from,
      Date.parse("2026-11-17T10:06:00.000Z"),
    );
    const [bucket] = [...fold.buckets.values()];
    expect(bucket?.output.below).toBe(37);
    expect(bucket?.input.below).toBe(20);
  });
});
