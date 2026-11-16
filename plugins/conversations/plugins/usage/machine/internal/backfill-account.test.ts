import { describe, expect, test } from "bun:test";
import type { UsageTokens } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import { backfillAccountOf } from "./backfill-account";

const tokens = (output: number): UsageTokens => ({
  input: { below: 0, above: 0 },
  output: { below: output, above: 0 },
  cacheRead: { below: 0, above: 0 },
  cacheCreate5m: { below: 0, above: 0 },
  cacheCreate1h: { below: 0, above: 0 },
});

const running = {
  account: "acct-a",
  since: new Date("2026-11-16T10:00:00.000Z"),
};

describe("backfillAccountOf", () => {
  test("a bucket starting at the process start is the agent's", () => {
    expect(
      backfillAccountOf(
        running,
        new Date("2026-11-16T10:00:00.000Z"),
        tokens(5),
      ),
    ).toBe("acct-a");
  });

  test("a later bucket is the agent's", () => {
    expect(
      backfillAccountOf(
        running,
        new Date("2026-11-16T13:00:00.000Z"),
        tokens(5),
      ),
    ).toBe("acct-a");
  });

  test("the bucket the process started in may hold an earlier process's tokens: unknown", () => {
    const started = { ...running, since: new Date("2026-11-16T10:30:00.000Z") };
    expect(
      backfillAccountOf(
        started,
        new Date("2026-11-16T10:00:00.000Z"),
        tokens(5),
      ),
    ).toBeNull();
  });

  test("a legacy day bucket counts from its midnight", () => {
    expect(
      backfillAccountOf(
        running,
        new Date("2026-11-16T00:00:00.000Z"),
        tokens(5),
      ),
    ).toBeNull();
    expect(
      backfillAccountOf(
        running,
        new Date("2026-11-17T00:00:00.000Z"),
        tokens(5),
      ),
    ).toBe("acct-a");
  });

  test("a take-back stays unknown", () => {
    expect(
      backfillAccountOf(
        running,
        new Date("2026-11-16T12:00:00.000Z"),
        tokens(-5),
      ),
    ).toBeNull();
  });

  test("no running agent: unknown", () => {
    expect(
      backfillAccountOf(null, new Date("2026-11-16T12:00:00.000Z"), tokens(5)),
    ).toBeNull();
  });

  test("an unreadable bucket hour: unknown", () => {
    expect(backfillAccountOf(running, new Date("nope"), tokens(5))).toBeNull();
  });
});
