import { describe, expect, test } from "bun:test";
import { claudeUsageOf, claudeUsageOfReply } from "./claude-usage";

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

// The get_usage reply's shape (recorded from Claude Code 2.1.308, trimmed).
const reply = (rate_limits: unknown, rate_limits_available = true) => ({
  subscription_type: "max",
  rate_limits_available,
  rate_limits,
  session: { total_cost_usd: 0 },
});

describe("claudeUsageOfReply", () => {
  test("reads percentages as fractions and ISO resets as milliseconds", () => {
    expect(
      claudeUsageOfReply(
        reply({
          five_hour: {
            utilization: 7,
            resets_at: "2026-10-22T18:50:00.330657+00:00",
            limit_dollars: null,
          },
          seven_day: {
            utilization: 81,
            resets_at: "2026-10-23T07:00:00.330678+00:00",
          },
          seven_day_opus: null,
        }),
        42,
      ),
    ).toEqual({
      kind: "read",
      usage: {
        observedAt: 42,
        session: {
          utilization: 0.07,
          resetsAt: Date.parse("2026-10-22T18:50:00.330Z"),
        },
        week: {
          utilization: 0.81,
          resetsAt: Date.parse("2026-10-23T07:00:00.330Z"),
        },
      },
    });
  });

  test("a window without a utilization or reset is no window", () => {
    const r = claudeUsageOfReply(
      reply({
        five_hour: null,
        seven_day: { utilization: 50, resets_at: "2026-10-23T07:00:00Z" },
      }),
      1,
    );
    expect(r.kind === "read" && r.usage.session).toBeNull();
  });

  test("no plan limits is unavailable, never an empty reading", () => {
    expect(claudeUsageOfReply(reply(null, false), 1).kind).toBe("unavailable");
    expect(
      claudeUsageOfReply(reply({ five_hour: null, seven_day: null }), 1).kind,
    ).toBe("unavailable");
  });

  test("a changed shape throws", () => {
    expect(() =>
      claudeUsageOfReply(reply({ seven_day: { utilization: "81%" } }), 1),
    ).toThrow();
  });
});
