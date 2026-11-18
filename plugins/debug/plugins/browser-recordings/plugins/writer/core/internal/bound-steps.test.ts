import { describe, expect, test } from "bun:test";
import type { RecordingStep } from "@plugins/debug/plugins/browser-recordings/core";
import { boundSteps } from "./bound-steps";

const step = (
  title: string,
  startMs: number,
  extra: Partial<RecordingStep> = {},
): RecordingStep => ({ title, startMs, durationMs: 1, ...extra });

describe("boundSteps", () => {
  test("folds consecutive identical calls into one step with a repeat count", () => {
    const out = boundSteps([
      step("goto", 0, { frame: "a" }),
      step("poll", 10, { frame: "a" }),
      step("poll", 20, { frame: "a" }),
      step("poll", 30, { frame: "a" }),
      step("click", 40, { frame: "b" }),
    ]);
    expect(out.omitted).toBeUndefined();
    expect(out.steps.map((s) => [s.title, s.repeat])).toEqual([
      ["goto", undefined],
      ["poll", 3],
      ["click", undefined],
    ]);
    // From the first call's start to the last one's end.
    expect(out.steps[1]?.durationMs).toBe(21);
  });

  test("never folds a failing call, nor calls that ended on different frames", () => {
    const out = boundSteps([
      step("poll", 0, { frame: "a" }),
      step("poll", 10, { frame: "b" }),
      step("poll", 20, { frame: "b", error: "boom" }),
      step("poll", 30, { frame: "b", error: "boom" }),
    ]);
    expect(out.steps).toHaveLength(4);
  });

  test("keeps the first and last halves past the cap and counts the calls between", () => {
    const steps = Array.from({ length: 10 }, (_, i) =>
      step(`s${i}`, i, i === 4 ? { repeat: 5 } : {}),
    );
    const out = boundSteps(steps, 4);
    expect(out.steps.map((s) => s.title)).toEqual(["s0", "s1", "s8", "s9"]);
    // s2..s7, s4 standing for 5 calls.
    expect(out.omitted).toEqual({ at: 2, calls: 10 });
  });
});
