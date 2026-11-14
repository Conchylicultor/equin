import { describe, expect, test } from "bun:test";
import { STALL } from "./constants";
import {
  reduceStallStacks,
  STACKS,
  type KeptTrace,
  type ProfilerTrace,
} from "./stack-profile";

const ORIGIN = 1_700_000_000_000;
const IV = 20;

// frames: 0 spin, 1 render, 2 onmessage; stacks: 0 = onmessage, 1 = render <
// onmessage, 2 = spin < render < onmessage.
const BASE: Omit<ProfilerTrace, "samples"> = {
  resources: ["http://x.localhost:9000/artifacts/app.js"],
  frames: [
    { name: "spin", resourceId: 0, line: 10, column: 5 },
    { name: "render", resourceId: 0, line: 20, column: 1 },
    { name: "", resourceId: 0, line: 30, column: 2 },
  ],
  stacks: [
    { frameId: 2 },
    { parentId: 0, frameId: 1 },
    { parentId: 1, frameId: 0 },
  ],
};

/** A trace sampling `stackAt(t)` every IV ms over [from, to) (ms since ORIGIN). */
function kept(
  from: number,
  to: number,
  stackAt: (t: number) => number | undefined,
  over: Partial<KeptTrace> = {},
): KeptTrace {
  const samples: ProfilerTrace["samples"] = [];
  for (let t = from; t < to; t += IV) {
    const stackId = stackAt(t);
    samples.push(
      stackId === undefined ? { timestamp: t } : { timestamp: t, stackId },
    );
  }
  return {
    trace: { ...BASE, samples },
    timeOrigin: ORIGIN,
    startedAt: ORIGIN + from,
    stoppedAt: ORIGIN + to,
    full: false,
    ...over,
  };
}

const SPIN = "spin (http://x.localhost:9000/artifacts/app.js:10:5)";
const RENDER = "render (http://x.localhost:9000/artifacts/app.js:20:1)";
const ANON = "(anonymous) (http://x.localhost:9000/artifacts/app.js:30:2)";

describe("reduceStallStacks", () => {
  test("aggregates the samples inside the stall by exact stack, heaviest first", () => {
    // Idle before the stall; inside it, 3/4 in spin, 1/4 in render.
    const t = kept(0, 20_000, (at) =>
      at < 5000 ? undefined : at % 80 === 0 ? 1 : 2,
    );
    const r = reduceStallStacks({
      traces: [t],
      startedAt: ORIGIN + 5000,
      endedAt: ORIGIN + 15_000,
      sampleIntervalMs: IV,
    });
    if (r.kind !== "sampled") throw new Error(r.reason);
    expect(r.sampledMs).toBe(10_000);
    expect(r.noJsMs).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.sampleIntervalMs).toBe(IV);
    expect(r.stacks.map((s) => s.ms)).toEqual([7500, 2500]);
    expect(r.stacks[0]!.frames).toEqual([SPIN, RENDER, ANON]);
    expect(r.stacks[0]!.samples).toBe(375);
    expect(r.topSelf).toEqual([
      { frame: SPIN, ms: 7500 },
      { frame: RENDER, ms: 2500 },
    ]);
  });

  test("samples with no stack are no-JS time, never a stack", () => {
    const t = kept(0, 10_000, (at) => (at % 40 === 0 ? undefined : 2));
    const r = reduceStallStacks({
      traces: [t],
      startedAt: ORIGIN,
      endedAt: ORIGIN + 10_000,
      sampleIntervalMs: IV,
    });
    if (r.kind !== "sampled") throw new Error(r.reason);
    expect(r.noJsMs).toBe(5000);
    expect(r.stacks).toHaveLength(1);
  });

  test("a stall no trace was running at the start of is unavailable, not empty", () => {
    // The tab was hidden (profiler stopped) when it began, then sampled again.
    const before = kept(0, 4000, () => 2);
    const after = kept(9000, 20_000, () => 2);
    const r = reduceStallStacks({
      traces: [before, after],
      startedAt: ORIGIN + 5000,
      endedAt: ORIGIN + 12_000,
      sampleIntervalMs: IV,
    });
    expect(r.kind).toBe("unavailable");
    expect(
      reduceStallStacks({
        traces: [],
        startedAt: ORIGIN,
        endedAt: ORIGIN + 1,
        sampleIntervalMs: IV,
      }).kind,
    ).toBe("unavailable");
  });

  test("rotated traces are joined: each owns the instants up to the next one's start", () => {
    // The old trace still holds samples past the new one's start (stop is
    // async): they must not be counted twice.
    const a = kept(0, 6000, () => 2, { stoppedAt: ORIGIN + 6000 });
    const b = kept(5000, 12_000, () => 1);
    const r = reduceStallStacks({
      traces: [b, a],
      startedAt: ORIGIN + 2000,
      endedAt: ORIGIN + 10_000,
      sampleIntervalMs: IV,
    });
    if (r.kind !== "sampled") throw new Error(r.reason);
    expect(r.sampledMs).toBe(8000);
    expect(r.stacks.map((s) => [s.frames[0], s.ms])).toEqual([
      [RENDER, 5000],
      [SPIN, 3000],
    ]);
  });

  test("a buffer that filled before the stall ended marks it truncated", () => {
    const t = kept(0, 7000, () => 2, {
      full: true,
      stoppedAt: ORIGIN + 30_000,
    });
    const r = reduceStallStacks({
      traces: [t],
      startedAt: ORIGIN + 1000,
      endedAt: ORIGIN + 20_000,
      sampleIntervalMs: IV,
    });
    if (r.kind !== "sampled") throw new Error(r.reason);
    expect(r.truncated).toBe(true);
    expect(r.sampledMs).toBe(6000);
  });

  test("a gap in sampling counts one interval, not the gap", () => {
    const t = kept(0, 1000, () => 2, { stoppedAt: ORIGIN + 6000 });
    t.trace.samples.push({ timestamp: 5000, stackId: 2 });
    const r = reduceStallStacks({
      traces: [t],
      startedAt: ORIGIN,
      endedAt: ORIGIN + 6000,
      sampleIntervalMs: IV,
    });
    if (r.kind !== "sampled") throw new Error(r.reason);
    expect(r.sampledMs).toBe(1000 + IV);
  });

  test("bounded: few stacks, few frames each, capped strings", () => {
    const deep = 60;
    const frames = Array.from({ length: deep }, (_, i) => ({
      name: `f${i}${"x".repeat(STALL.STRING_CAP)}`,
    }));
    const stacks = frames.map((_, i) =>
      i === 0 ? { frameId: 0 } : { parentId: i - 1, frameId: i },
    );
    const samples = Array.from({ length: 40 * deep }, (_, i) => ({
      timestamp: i * IV,
      stackId: i % deep,
    }));
    const r = reduceStallStacks({
      traces: [
        {
          trace: { resources: [], frames, stacks, samples },
          timeOrigin: ORIGIN,
          startedAt: ORIGIN,
          stoppedAt: ORIGIN + samples.length * IV,
          full: false,
        },
      ],
      startedAt: ORIGIN,
      endedAt: ORIGIN + samples.length * IV,
      sampleIntervalMs: IV,
    });
    if (r.kind !== "sampled") throw new Error(r.reason);
    expect(r.stacks).toHaveLength(STACKS.TOP_STACKS);
    expect(r.topSelf).toHaveLength(STACKS.TOP_SELF);
    for (const s of r.stacks) {
      expect(s.frames.length).toBeLessThanOrEqual(STACKS.MAX_FRAMES + 1);
      for (const f of s.frames)
        expect(f.length).toBeLessThanOrEqual(STALL.STRING_CAP + 1);
    }
  });
});
