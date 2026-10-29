import { describe, expect, test } from "bun:test";
import { defineEndpoint } from "./define-endpoint";
import { brandEndpointEffect } from "./endpoint-effect";
import { PREDICTION_GAPS } from "./prediction";

// The runtime backstop of `defineEndpoint`'s decision arms: tsc refuses all of
// these, so each is declared through a cast (`as never`), the way a cast past
// tsc would reach it.
const declare = (opts: Record<string, unknown>) => () =>
  defineEndpoint(opts as never);
const effect = () => brandEndpointEffect({});

describe("defineEndpoint decision backstop", () => {
  test("a write with no arm throws, naming the route and the arms", () => {
    expect(declare({ route: "POST /api/b/none" })).toThrow(
      /POST \/api\/b\/none.*exactly one of `effect.*unpredicted.*internal.*agentWrite: "telemetry"/,
    );
    expect(
      declare({ route: "POST /api/b/ctl", agentWrite: "agent-control" }),
    ).toThrow(/exactly one of/);
  });

  test("two arms throw", () => {
    expect(
      declare({
        route: "POST /api/b/two",
        effect,
        unpredicted: { gap: "web-context" },
      }),
    ).toThrow(/declares `effect` and `unpredicted`/);
    expect(
      declare({
        route: "POST /api/b/two",
        agentWrite: "telemetry",
        internal: { why: "x" },
      }),
    ).toThrow(/telemetry.*drop `internal`/);
  });

  test("an empty or whitespace why throws", () => {
    expect(
      declare({
        route: "POST /api/b/why",
        unpredicted: { reason: "response", why: "  " },
      }),
    ).toThrow(/POST \/api\/b\/why.*unpredicted\.why needs a reason/);
    expect(
      declare({
        route: "POST /api/b/why",
        unpredicted: { reason: "response" },
      }),
    ).toThrow(/unpredicted\.why needs a reason/);
    expect(
      declare({ route: "POST /api/b/why", internal: { why: "" } }),
    ).toThrow(/internal\.why needs a reason/);
    expect(declare({ route: "POST /api/b/why", internal: {} })).toThrow(
      /internal\.why needs a reason/,
    );
  });

  test("an unknown reason or gap throws, listing the valid ones", () => {
    expect(
      declare({
        route: "POST /api/b/r",
        unpredicted: { reason: "slow", why: "x" },
      }),
    ).toThrow(/"slow" is not an UnpredictedReason — one of server-minted-id/);
    expect(
      declare({ route: "POST /api/b/g", unpredicted: { gap: "spinners" } }),
    ).toThrow(/"spinners" is not a PredictionGap — one of web-context/);
    // An inherited key is not a gap.
    expect(
      declare({ route: "POST /api/b/g", unpredicted: { gap: "toString" } }),
    ).toThrow(/is not a PredictionGap/);
    expect(
      declare({
        route: "POST /api/b/g",
        unpredicted: { gap: "web-context", reason: "response", why: "x" },
      }),
    ).toThrow(/not both/);
    expect(
      declare({ route: "POST /api/b/g", unpredicted: "web-context" }),
    ).toThrow(/unpredicted is \{ reason, why \} or \{ gap \}/);
  });

  test("a read with any arm throws", () => {
    for (const arm of [
      { effect },
      { unpredicted: { reason: "response", why: "x" } },
      { internal: { why: "x" } },
    ]) {
      expect(declare({ route: "GET /api/b/r", ...arm })).toThrow(
        /GET \/api\/b\/r.*on a read/,
      );
    }
  });

  test("each valid arm declares, and the def carries its decision", () => {
    const reason = defineEndpoint({
      route: "POST /api/b/ok1",
      unpredicted: { reason: "precondition", why: "409 shown inline" },
    });
    expect(reason.unpredicted).toEqual({
      reason: "precondition",
      why: "409 shown inline",
    });
    expect(reason.internal).toBeUndefined();
    const gap = defineEndpoint({
      route: "POST /api/b/ok2",
      unpredicted: { gap: "web-context" },
    });
    expect(gap.unpredicted).toEqual({ gap: "web-context" });
    const internal = defineEndpoint({
      route: "POST /api/b/ok3",
      internal: { why: "server → central RPC" },
    });
    expect(internal.internal).toEqual({ why: "server → central RPC" });
    expect("unpredicted" in internal).toBe(false);
    const telemetry = defineEndpoint({
      route: "POST /api/b/ok4",
      agentWrite: "telemetry",
    });
    expect("unpredicted" in telemetry).toBe(false);
    expect("internal" in telemetry).toBe(false);
    const read = defineEndpoint({ route: "GET /api/b/ok5" });
    expect("unpredicted" in read).toBe(false);
  });

  test("every gap names its task and what it blocks", () => {
    for (const [gap, { task, what }] of Object.entries(PREDICTION_GAPS)) {
      expect(task, gap).toMatch(/^task-/);
      expect(what.trim().length, gap).toBeGreaterThan(0);
    }
  });
});
