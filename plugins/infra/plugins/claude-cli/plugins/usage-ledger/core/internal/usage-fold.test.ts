import { describe, expect, test } from "bun:test";
import type { DayBucket } from "./buckets";
import {
  emptyUsageBuckets,
  foldUsageEntry,
  resumeUsageBuckets,
  resumeUsageDelta,
  type UsageBuckets,
} from "./usage-fold";

/** One assistant line as Claude Code writes it (one per content block). */
const entry = (
  id: string,
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    create5m?: number;
    create1h?: number;
  },
  timestamp = "2026-11-16T09:30:00.000Z",
  model = "claude-test",
) => ({
  type: "assistant",
  timestamp,
  requestId: `req-${id}`,
  message: {
    id,
    model,
    usage: {
      input_tokens: usage.input ?? 0,
      output_tokens: usage.output ?? 0,
      cache_read_input_tokens: usage.cacheRead ?? 0,
      cache_creation_input_tokens:
        (usage.create5m ?? 0) + (usage.create1h ?? 0),
      cache_creation: {
        ephemeral_5m_input_tokens: usage.create5m ?? 0,
        ephemeral_1h_input_tokens: usage.create1h ?? 0,
      },
    },
  },
});

const buckets = (fold: UsageBuckets): DayBucket[] =>
  [...fold.buckets.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.hour ?? -1) - (b.hour ?? -1) ||
      a.model.localeCompare(b.model),
  );

describe("foldUsageEntry", () => {
  test("buckets every entry by its UTC hour, model and speed", () => {
    const fold = emptyUsageBuckets();
    foldUsageEntry(fold, entry("a", { input: 10 }, "2026-11-16T09:00:00Z"));
    foldUsageEntry(fold, entry("b", { input: 5 }, "2026-11-16T09:59:59Z"));
    foldUsageEntry(fold, entry("c", { input: 7 }, "2026-11-16T10:00:00Z"));
    foldUsageEntry(
      fold,
      entry("d", { input: 1 }, "2026-11-16T10:00:00Z", "claude-other"),
    );
    expect(
      buckets(fold).map((b) => [b.date, b.hour, b.model, b.input.below]),
    ).toEqual([
      ["2026-11-16", 9, "claude-test", 15],
      ["2026-11-16", 10, "claude-other", 1],
      ["2026-11-16", 10, "claude-test", 7],
    ]);
  });

  test("counts a message once, at its largest output, in the bucket it went to", () => {
    const fold = emptyUsageBuckets();
    expect(
      foldUsageEntry(fold, entry("m", { input: 100, output: 8 }))?.kind,
    ).toBe("entry");
    expect(
      foldUsageEntry(fold, entry("m", { input: 100, output: 3778 })),
    ).toMatchObject({ kind: "top-up", output: 3770, input: 0 });
    // A repeat with no more output adds nothing.
    expect(foldUsageEntry(fold, entry("m", { input: 100, output: 20 }))).toBe(
      null,
    );
    const [b] = buckets(fold);
    expect(b!.input.below).toBe(100);
    expect(b!.output.below).toBe(3778);
  });

  test("tiers each entry at 200k before aggregating, cache creation on its combined count", () => {
    const fold = emptyUsageBuckets();
    foldUsageEntry(fold, entry("x", { input: 250_000 }));
    foldUsageEntry(fold, entry("y", { input: 150_000 }));
    foldUsageEntry(fold, entry("z", { create5m: 150_000, create1h: 150_000 }));
    const [b] = buckets(fold);
    expect(b!.input).toEqual({ below: 350_000, above: 50_000 });
    // 300k combined: 200k below, 100k above, split by the 5m/1h share (½ each).
    expect(b!.cacheCreate5m).toEqual({ below: 100_000, above: 50_000 });
    expect(b!.cacheCreate1h).toEqual({ below: 100_000, above: 50_000 });
  });

  test("ignores a line with no usage, or one that is not an object", () => {
    const fold = emptyUsageBuckets();
    expect(foldUsageEntry(fold, { type: "user" })).toBe(null);
    expect(foldUsageEntry(fold, "text")).toBe(null);
    expect(fold.buckets.size).toBe(0);
  });
});

describe("resumeUsageBuckets", () => {
  test("folds on exactly where the fold it resumes stopped, without mutating its buckets", () => {
    const lines = [
      entry("a", { input: 10, output: 1 }),
      entry("a", { input: 10, output: 40 }),
      entry("b", { input: 3, output: 2 }, "2026-11-16T11:00:00Z"),
    ];
    const whole = emptyUsageBuckets();
    for (const l of lines) foldUsageEntry(whole, l);

    const first = emptyUsageBuckets();
    foldUsageEntry(first, lines[0]);
    const saved = [...first.buckets.values()];
    const resumed = resumeUsageBuckets(saved, first.seen);
    for (const l of lines.slice(1)) foldUsageEntry(resumed, l);

    expect(buckets(resumed)).toEqual(buckets(whole));
    expect(saved[0]!.output.below).toBe(1);
  });
});

describe("resumeUsageDelta", () => {
  test("its buckets hold only what the new lines added, a top-up of an earlier entry included", () => {
    const first = emptyUsageBuckets();
    foldUsageEntry(first, entry("a", { input: 10, output: 1 }));

    const delta = resumeUsageDelta(first.seen);
    foldUsageEntry(delta, entry("a", { input: 10, output: 40 }));
    foldUsageEntry(delta, entry("b", { input: 3 }, "2026-11-16T11:00:00Z"));

    const byHour = new Map(
      buckets(delta).map((b) => [b.hour, [b.input.below, b.output.below]]),
    );
    expect(byHour).toEqual(
      new Map([
        [9, [0, 39]],
        [11, [3, 0]],
      ]),
    );
  });

  test("a model name with spaces survives the bucket key", () => {
    const first = emptyUsageBuckets();
    foldUsageEntry(
      first,
      entry("a", { output: 1 }, "2026-11-16T09:00:00Z", "odd model name"),
    );
    const delta = resumeUsageDelta(first.seen);
    foldUsageEntry(
      delta,
      entry("a", { output: 5 }, "2026-11-16T09:00:00Z", "odd model name"),
    );
    expect(buckets(delta)).toMatchObject([
      {
        date: "2026-11-16",
        hour: 9,
        model: "odd model name",
        speed: "standard",
      },
    ]);
    expect(buckets(delta)[0]!.output.below).toBe(4);
  });
});
