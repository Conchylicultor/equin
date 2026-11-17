import { describe, expect, test } from "bun:test";
import type { DayBucket } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import { costSteps, usageLineOf } from "./cost-stretch";

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

describe("costSteps", () => {
  const parse = (...texts: string[]) =>
    texts.map((t) => {
      const l = usageLineOf(t);
      if (!l) throw new Error(`not a usage line: ${t}`);
      return l;
    });
  const from = Date.parse("2026-11-17T10:00:00.000Z");
  const to = from + 3_600_000;
  // A stand-in price: one dollar per input or output token.
  const price = (b: DayBucket) =>
    b.model === "unpriced" ? null : b.input.below + b.output.below;
  const at = (iso: string) => Date.parse(iso);

  test("one step per instant in the hour, on top of the cost before it", () => {
    const main = parse(
      line("2026-11-17T09:59:59.000Z", "m0", 100),
      line("2026-11-17T10:01:00.000Z", "m1", 7),
      line("2026-11-17T10:30:00.000Z", "m2", 1000),
      line("2026-11-17T11:00:00.000Z", "m3", 1),
    );
    expect(costSteps([main], from, to, 5, price).steps).toEqual([
      { t: at("2026-11-17T10:01:00.000Z"), costUsd: 5 + 17 },
      { t: at("2026-11-17T10:30:00.000Z"), costUsd: 5 + 17 + 1010 },
    ]);
  });

  test("a sub-agent's lines count by their own instants, a copied line once", () => {
    const first = parse(line("2026-11-17T10:01:00.000Z", "m1", 7));
    // A resumed session's file copies the history before it.
    const resumed = parse(
      line("2026-11-17T10:01:00.000Z", "m1", 7),
      line("2026-11-17T10:20:00.000Z", "m3", 2),
    );
    const agent = parse(line("2026-11-17T10:05:00.000Z", "a1", 30));
    expect(
      costSteps([first, resumed, agent], from, to, 0, price).steps,
    ).toEqual([
      { t: at("2026-11-17T10:01:00.000Z"), costUsd: 17 },
      { t: at("2026-11-17T10:05:00.000Z"), costUsd: 57 },
      { t: at("2026-11-17T10:20:00.000Z"), costUsd: 69 },
    ]);
  });

  test("a message begun before the hour stays the earlier hour's", () => {
    const main = parse(
      line("2026-11-17T09:59:59.000Z", "m0", 100),
      line("2026-11-17T10:00:01.000Z", "m0", 150),
      line("2026-11-17T10:02:00.000Z", "m1", 7),
    );
    expect(costSteps([main], from, to, 5, price).steps).toEqual([
      { t: at("2026-11-17T10:02:00.000Z"), costUsd: 5 + 17 },
    ]);
  });

  test("a message's later, larger line tops it up; a smaller one is no step", () => {
    const main = parse(
      line("2026-11-17T10:01:00.000Z", "m1", 7),
      line("2026-11-17T10:02:00.000Z", "m1", 3),
      line("2026-11-17T10:03:00.000Z", "m1", 9),
    );
    expect(costSteps([main], from, to, 0, price).steps).toEqual([
      { t: at("2026-11-17T10:01:00.000Z"), costUsd: 17 },
      { t: at("2026-11-17T10:03:00.000Z"), costUsd: 19 },
    ]);
  });

  test("an unpriced model is named from its first line, never priced as $0", () => {
    const main = parse(
      line("2026-11-17T10:01:00.000Z", "m1", 7),
      line("2026-11-17T10:04:00.000Z", "u1", 7, {}).replace(
        '"test-model"',
        '"unpriced"',
      ),
    );
    const { steps, unpricedFrom } = costSteps([main], from, to, 0, price);
    expect(steps).toEqual([{ t: at("2026-11-17T10:01:00.000Z"), costUsd: 17 }]);
    expect(unpricedFrom).toEqual([
      { model: "unpriced", t: at("2026-11-17T10:04:00.000Z") },
    ]);
  });
});
