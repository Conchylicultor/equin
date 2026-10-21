import { describe, expect, test } from "bun:test";
import { claudeUsageOf } from "./claude-usage";

// The shape the CLI sends (recorded from a real agent's events.jsonl).
const event = (unifiedWindows?: unknown) => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1792560600,
    rateLimitType: "five_hour",
    ...(unifiedWindows === undefined ? {} : { unifiedWindows }),
  },
});

describe("claudeUsageOf", () => {
  test("reads both windows, resets in milliseconds", () => {
    expect(
      claudeUsageOf(
        event({
          five_hour: { utilization: 0.84, resetsAt: 1792560600 },
          seven_day: { utilization: 0.6, resetsAt: 1792738800 },
        }),
        42,
      ),
    ).toEqual({
      observedAt: 42,
      session: { utilization: 0.84, resetsAt: 1792560600_000 },
      week: { utilization: 0.6, resetsAt: 1792738800_000 },
    });
  });

  test("a missing window is null", () => {
    expect(
      claudeUsageOf(
        event({ seven_day: { utilization: 0.6, resetsAt: 1792738800 } }),
        42,
      )?.session,
    ).toBeNull();
  });

  test("no windows, or another message, is null", () => {
    expect(claudeUsageOf(event(), 42)).toBeNull();
    expect(claudeUsageOf(event({}), 42)).toBeNull();
    expect(claudeUsageOf({ type: "assistant" }, 42)).toBeNull();
  });

  test("a changed shape throws", () => {
    expect(() =>
      claudeUsageOf(event({ five_hour: { utilization: "84%" } }), 42),
    ).toThrow();
  });
});
