import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  collectContributions,
  type ServerErrorReport,
} from "@plugins/framework/plugins/server-core/core";
import { setServerErrorHandler } from "@plugins/framework/plugins/server-core/core/testing";
import type { TraceTrigger, TripContext } from "../../core";
import { defineTraceEventClass, type TraceEventClassSpec } from "./registry";
import { resetRateLimit } from "./rate-limit";
import {
  captureAtTripPhase,
  assembleEvents,
  captureTrace,
  _setTraceConfigForTests,
} from "./capture";
import {
  shouldShedTrace,
  _setTraceShedAdmitForTests,
  type TraceShedStub,
} from "./trace-shed";

// Capture the loud server-error reports the engine files on a bad section, so
// "isolated but loud" is asserted, not assumed. The server error handler is
// global — set before each test, cleared after.
let reports: ServerErrorReport[] = [];

beforeEach(() => {
  reports = [];
  setServerErrorHandler((r) => reports.push(r));
});
afterEach(() => {
  setServerErrorHandler(null);
});

const ctx: TripContext = {
  id: "test-id",
  atMs: 1_000,
  wallTime: "2026-07-08T00:00:00.000Z",
  windowStartMs: 0,
  trigger: { kind: "loader", label: "x", durationMs: 500, thresholdMs: 100 },
};

describe("captureAtTripPhase", () => {
  test("fans out to every class, skips undefined, isolates a thrower", () => {
    const specs: TraceEventClassSpec[] = [
      { id: "a", schema: z.unknown(), captureAtTrip: () => ({ n: 1 }) },
      { id: "skip", schema: z.unknown(), captureAtTrip: () => undefined },
      {
        id: "boom",
        schema: z.unknown(),
        captureAtTrip: () => {
          throw new Error("nope");
        },
      },
      { id: "no-capture", schema: z.unknown() },
    ];

    const out = captureAtTripPhase(specs, ctx);

    expect(out.get("a")).toEqual({ n: 1 });
    expect(out.has("skip")).toBe(false);
    expect(out.has("boom")).toBe(false);
    expect(out.has("no-capture")).toBe(false);
    // The thrower is loud: exactly one report, naming the class.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toContain('trace class "boom"');
  });
});

describe("assembleEvents", () => {
  test("persists a captureAtTrip section that passes its schema", async () => {
    const specs: TraceEventClassSpec[] = [
      { id: "spans", schema: z.object({ n: z.number() }) },
    ];
    const events = await assembleEvents(
      specs,
      ctx,
      new Map([["spans", { n: 3 }]]),
    );
    expect(events).toEqual({ spans: { n: 3 } });
    expect(reports).toHaveLength(0);
  });

  test("enrich receives the phase-1 output and its result is validated", async () => {
    let seen: unknown;
    const specs: TraceEventClassSpec[] = [
      {
        id: "contention",
        schema: z.object({ load: z.number() }),
        enrich: (_c, atTrip) => {
          seen = atTrip;
          return { load: 42 };
        },
      },
    ];
    const events = await assembleEvents(
      specs,
      ctx,
      new Map([["contention", { fromTrip: true }]]),
    );
    expect(seen).toEqual({ fromTrip: true });
    expect(events).toEqual({ contention: { load: 42 } });
  });

  test("a section that fails validation is OMITTED and reported; siblings survive", async () => {
    const specs: TraceEventClassSpec[] = [
      { id: "good", schema: z.object({ ok: z.boolean() }) },
      { id: "bad", schema: z.object({ ok: z.boolean() }) },
    ];
    const events = await assembleEvents(
      specs,
      ctx,
      new Map<string, unknown>([
        ["good", { ok: true }],
        ["bad", { ok: "not-a-boolean" }],
      ]),
    );
    expect(events).toEqual({ good: { ok: true } });
    expect(events).not.toHaveProperty("bad");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toContain('trace class "bad"');
    expect(reports[0]?.message).toContain("failed validation");
  });

  test("an enrich returning undefined skips the section — no error, no report", async () => {
    const specs: TraceEventClassSpec[] = [
      {
        id: "selective",
        schema: z.object({ load: z.number() }),
        enrich: () => undefined,
      },
      {
        id: "active",
        schema: z.object({ load: z.number() }),
        enrich: () => ({ load: 7 }),
      },
    ];
    const events = await assembleEvents(specs, ctx, new Map());
    expect(events).toEqual({ active: { load: 7 } });
    expect(events).not.toHaveProperty("selective");
    expect(reports).toHaveLength(0);
  });

  test("a class with neither phase-1 output nor a ring contributes no section", async () => {
    const specs: TraceEventClassSpec[] = [{ id: "empty", schema: z.unknown() }];
    const events = await assembleEvents(specs, ctx, new Map());
    expect(events).toEqual({});
    expect(reports).toHaveLength(0);
  });

  test("an enrich that throws is isolated and reported", async () => {
    const specs: TraceEventClassSpec[] = [
      {
        id: "throws",
        schema: z.unknown(),
        enrich: () => {
          throw new Error("enrich boom");
        },
      },
      { id: "fine", schema: z.number() },
    ];
    const events = await assembleEvents(
      specs,
      ctx,
      new Map<string, unknown>([["fine", 7]]),
    );
    expect(events).toEqual({ fine: 7 });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toContain('trace class "throws"');
  });
});

describe("duress shed gate", () => {
  const cfg = {
    enabled: true,
    cooldownMs: 0,
    maxPerMin: 1_000,
    windowMs: 10_000,
  };
  const trigger: TraceTrigger = {
    kind: "loader",
    label: "x",
    durationMs: 500,
    thresholdMs: 100,
  };

  beforeEach(() => {
    resetRateLimit();
    _setTraceConfigForTests(cfg);
  });
  afterEach(() => {
    resetRateLimit();
    _setTraceConfigForTests(null);
    _setTraceShedAdmitForTests(null);
    collectContributions([]);
  });

  test("a non-critical trip shed past first-N returns null and skips every capture phase", () => {
    // A probe class proves the coherent-instant phase never ran — the whole
    // point of shedding is to skip that cost, not just the row insert.
    let probeCalls = 0;
    const probe = defineTraceEventClass({
      id: "shed-probe",
      schema: z.unknown(),
      captureAtTrip: () => {
        probeCalls += 1;
        return { seen: true };
      },
    });
    collectContributions([{ id: "test", contributions: [probe.contribution] }]);

    const stubs: TraceShedStub[] = [];
    _setTraceShedAdmitForTests((stub) => {
      stubs.push(stub);
      return { persist: false };
    });

    expect(captureTrace(trigger)).toBeNull();
    expect(probeCalls).toBe(0);
    // The buffered stub carries the accounting fields, nothing more.
    expect(stubs).toHaveLength(1);
    expect(stubs[0]).toMatchObject({
      kind: "loader",
      label: "x",
      durationMs: 500,
    });
    expect(typeof stubs[0]?.wallTime).toBe("string");
  });

  test("the gate sits after admission — a cooldown rejection never reaches the shed buffer", () => {
    _setTraceConfigForTests({ ...cfg, cooldownMs: 60_000 });
    const stubs: TraceShedStub[] = [];
    _setTraceShedAdmitForTests((stub) => {
      stubs.push(stub);
      return { persist: false };
    });

    expect(captureTrace(trigger)).toBeNull(); // admitted, then shed
    expect(captureTrace(trigger)).toBeNull(); // cooldown-rejected before the gate
    expect(stubs).toHaveLength(1);
  });

  test("a critical trigger bypasses the shed gate without consuming a first-N grant", () => {
    const stubs: TraceShedStub[] = [];
    _setTraceShedAdmitForTests((stub) => {
      stubs.push(stub);
      return { persist: false };
    });

    expect(shouldShedTrace({ ...trigger, kind: "stall", critical: true })).toBe(
      false,
    );
    expect(stubs).toHaveLength(0);
  });

  test("a non-critical trip the buffer persists (first-N) is not shed", () => {
    _setTraceShedAdmitForTests(() => ({ persist: true }));
    expect(shouldShedTrace(trigger)).toBe(false);
  });
});
