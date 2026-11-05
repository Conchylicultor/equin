import { describe, expect, test } from "bun:test";
import { createActivityLog } from "./activity";
import {
  createSampleClock,
  createStackSamplerClaim,
  frameKey,
  normalizeTraces,
  type StackFrame,
} from "./sampler";

const NO_LINE = 4_294_967_295;

test("normalizeTraces maps JSC's sentinels and missing fields to typed values", () => {
  const samples = normalizeTraces({
    interval: 0.001,
    traces: [
      {
        timestamp: 12.5,
        frames: [
          {
            name: "spin",
            sourceURL: "/repo/a.ts",
            line: 9,
            column: 3,
            category: "LLInt",
            flags: 0,
          },
          {
            name: "evaluate",
            line: NO_LINE,
            column: NO_LINE,
            category: "Unknown Executable",
          },
          { name: "", sourceURL: "", line: 2, column: 1 },
        ],
      },
    ],
  });

  expect(samples).toEqual([
    {
      timestamp: 12.5,
      frames: [
        {
          name: "spin",
          sourceURL: "/repo/a.ts",
          line: 9,
          column: 3,
          category: "LLInt",
        },
        {
          name: "evaluate",
          sourceURL: null,
          line: null,
          column: null,
          category: "Unknown Executable",
        },
        { name: "", sourceURL: null, line: 2, column: 1, category: "native" },
      ],
    },
  ]);
});

test("normalizeTraces drops frameless traces", () => {
  const samples = normalizeTraces({
    interval: 0.001,
    traces: [
      { timestamp: 1, frames: [] },
      { timestamp: 2 },
      {
        timestamp: 3,
        frames: [
          {
            name: "kept",
            sourceURL: "/x.ts",
            line: 1,
            column: 1,
            category: "FTL",
          },
        ],
      },
    ],
  });
  expect(samples.map((s) => s.timestamp)).toEqual([3]);
});

test("normalizeTraces throws on a result that is not the JSC shape", () => {
  expect(() => normalizeTraces(undefined)).toThrow(/traces/);
  expect(() => normalizeTraces({ interval: 1 })).toThrow(/traces/);
  expect(() =>
    normalizeTraces({ traces: [{ frames: [{ name: "x" }] }] }),
  ).toThrow(/timestamp/);
});

const frame = (over: Partial<StackFrame>): StackFrame => ({
  name: "fn",
  sourceURL: null,
  line: null,
  column: null,
  category: "native",
  ...over,
});

test("frameKey: a JS frame with source + line reads `name @ path:line`", () => {
  const f = frame({
    name: "listPanes",
    sourceURL: "/repo/x/tmux.ts",
    line: 499,
    category: "FTL",
  });
  expect(frameKey(f)).toBe("listPanes @ /repo/x/tmux.ts:499");
  expect(frameKey(f, (s) => s.replace("/repo/", ""))).toBe(
    "listPanes @ x/tmux.ts:499",
  );
  expect(frameKey({ ...f, name: "" })).toBe(
    "(anonymous) @ /repo/x/tmux.ts:499",
  );
});

test("frameKey: a frame without source or line reads `name [category]`", () => {
  expect(frameKey(frame({ name: "now", category: "Unknown Executable" }))).toBe(
    "now [Unknown Executable]",
  );
  // A line without a source (asyncModuleEvaluation) is still not attributable.
  expect(
    frameKey(
      frame({ name: "asyncModuleEvaluation", line: 2, category: "LLInt" }),
    ),
  ).toBe("asyncModuleEvaluation [LLInt]");
  expect(frameKey(frame({ name: "", category: "" }))).toBe(
    "(anonymous) [native]",
  );
  // `shorten` only ever sees a real source path.
  expect(frameKey(frame({ name: "spawn" }), () => "never")).toBe(
    "spawn [native]",
  );
});

// The claim logic, against a fake profiler. The process-wide
// `claimStackSampler` is this same function bound to bun:jsc; it is not claimed
// here because `bun test` runs every file in one process, and a real claim under
// a test owner would make health-monitor's own claim throw.
function fakeBackend() {
  const state = {
    starts: 0,
    raw: { interval: 0.001, traces: [] as unknown[] },
  };
  return {
    state,
    backend: { start: () => void (state.starts += 1), read: () => state.raw },
  };
}

test("claim: the same owner twice gets the same handle, armed once", () => {
  const { state, backend } = fakeBackend();
  const claim = createStackSamplerClaim(backend);
  const a = claim("health-monitor");
  const b = claim("health-monitor");
  expect(b).toBe(a);
  expect(state.starts).toBe(1);
});

test("claim: a second owner throws, naming both owners", () => {
  const { state, backend } = fakeBackend();
  const claim = createStackSamplerClaim(backend);
  claim("health-monitor");
  expect(() => claim("check-thread-watch")).toThrow(
    /"check-thread-watch" cannot claim .* "health-monitor" already owns it/,
  );
  expect(state.starts).toBe(1);
});

test("claim: drain normalizes each read", () => {
  const { state, backend } = fakeBackend();
  const sampler = createStackSamplerClaim(backend, { now: () => 10 })("owner");
  state.raw = {
    interval: 0.001,
    traces: [
      {
        timestamp: 4,
        frames: [
          { name: "hot", sourceURL: "/a.ts", line: NO_LINE, category: "FTL" },
        ],
      },
    ],
  };
  expect(sampler.drain()).toEqual([
    {
      timestamp: 4,
      frames: [
        {
          name: "hot",
          sourceURL: "/a.ts",
          line: null,
          column: null,
          category: "FTL",
        },
      ],
      // A one-sample batch between two drains at 10 places it there.
      atMs: 10,
      activity: null,
    },
  ]);
});

describe("createSampleClock", () => {
  // JSC's clock runs 5000 s ahead of `performance.now()` in these fixtures.
  const OFFSET_MS = 5_000_000;
  const at = (ms: number) => ({
    timestamp: (ms + OFFSET_MS) / 1000,
    frames: [frame({})],
  });

  test("places nothing before a batch has been observed", () => {
    expect(createSampleClock().toMs(1)).toBeNull();
  });

  test("brackets the offset from drain times and narrows it across batches", () => {
    const clock = createSampleClock();
    // Busy right up to both drains: samples at 10 and 95 in the window (0, 100].
    clock.observe(0, 100, [at(10), at(95)]);
    // lower = 95 - 100 = -5, upper = 10 - 0 = 10 (relative to OFFSET_MS).
    expect(Math.abs(clock.toMs(at(50).timestamp)! - 50)).toBeLessThanOrEqual(8);
    clock.observe(100, 150, [at(101), at(149)]);
    // lower = max(-5, -1), upper = min(10, 1) → within 1 ms.
    expect(Math.abs(clock.toMs(at(120).timestamp)! - 120)).toBeLessThanOrEqual(
      1,
    );
  });

  test("a batch whose bounds contradict the estimate restarts it", () => {
    const clock = createSampleClock();
    clock.observe(0, 100, [at(1), at(99)]);
    // The clocks jumped by 1000 ms: the old bounds cannot hold both.
    const jumped = (ms: number) => at(ms + 1000);
    clock.observe(100, 200, [jumped(101), jumped(199)]);
    expect(
      Math.abs(clock.toMs(jumped(150).timestamp)! - 150),
    ).toBeLessThanOrEqual(1);
  });
});

describe("activities", () => {
  test("the log records nothing until armed, then the innermost containing interval", () => {
    const log = createActivityLog();
    expect(log.begin({ name: "x", detail: "early" }, 0)).toBeNull();
    log.arm();
    const outer = log.begin({ name: "x", detail: "outer" }, 10);
    const inner = log.begin({ name: "x", detail: "inner" }, 20);
    log.end(inner, 30);
    expect(log.at(5)).toBeNull();
    expect(log.at(15)?.detail).toBe("outer");
    expect(log.at(25)?.detail).toBe("inner");
    expect(log.at(35)?.detail).toBe("outer"); // still open
    log.end(outer, 40);
    expect(log.at(45)).toBeNull();
    log.prune(35);
    expect(log.at(25)?.detail).toBe("outer"); // inner pruned, outer ended at 40
  });

  test("drain stamps each sample with the activity running at its own time, not at drain time", () => {
    const OFFSET_MS = 7_000;
    let nowMs = 0;
    const raw = { interval: 0.001, traces: [] as unknown[] };
    const activities = createActivityLog();
    const sampler = createStackSamplerClaim(
      { start: () => {}, read: () => raw },
      { now: () => nowMs, activities },
    )("owner");
    const trace = (ms: number) => ({
      timestamp: (ms + OFFSET_MS) / 1000,
      frames: [{ name: "", line: NO_LINE, category: "Unknown Executable" }],
    });

    // One import from 20 to 60, cleared long before the drain at 100.
    const interval = activities.begin(
      {
        name: "barrel import",
        detail: "plugins/apps/plugins/mail/web/index.ts",
      },
      20,
    );
    activities.end(interval, 60);
    raw.traces = [trace(1), trace(30), trace(55), trace(80), trace(99)];
    nowMs = 100;

    expect(sampler.drain().map((s) => s.activity?.detail ?? null)).toEqual([
      null,
      "plugins/apps/plugins/mail/web/index.ts",
      "plugins/apps/plugins/mail/web/index.ts",
      null,
      null,
    ]);
  });

  test("drain places each sample on performance.now() once the clock has closed", () => {
    const OFFSET_MS = 7_000;
    let nowMs = 0;
    const raw = { interval: 0.001, traces: [] as unknown[] };
    const sampler = createStackSamplerClaim(
      { start: () => {}, read: () => raw },
      { now: () => nowMs },
    )("owner");
    const trace = (ms: number) => ({
      timestamp: (ms + OFFSET_MS) / 1000,
      frames: [{ name: "spin", line: NO_LINE, category: "FTL" }],
    });

    // A thread busy across the drain at 100: the first sample of the next batch
    // is taken right after it, the last right before it — the offset closes.
    raw.traces = [trace(0.5), trace(99.5)];
    nowMs = 100;
    sampler.drain();
    raw.traces = [trace(100.5), trace(150), trace(199.5)];
    nowMs = 200;
    const placed = sampler.drain().map((s) => s.atMs!);
    expect(placed[0]).toBeCloseTo(100.5, 0);
    expect(placed[1]).toBeCloseTo(150, 0);
    expect(placed[2]).toBeCloseTo(199.5, 0);
  });
});
