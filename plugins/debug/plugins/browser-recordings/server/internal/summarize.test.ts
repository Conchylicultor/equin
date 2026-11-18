import { describe, expect, test } from "bun:test";
import type { RecordingManifest, RecordingStep } from "../../core";
import { summarizeRun } from "./summarize";

const manifest = (
  steps: RecordingStep[],
  omitted?: RecordingManifest["omitted"],
): RecordingManifest => ({
  v: 2,
  source: { kind: "e2e", script: "x.ts" },
  toolUseId: null,
  startedAt: "2026-11-18T00:00:00.000Z",
  endedAt: "2026-11-18T00:00:01.000Z",
  steps,
  ...(omitted ? { omitted } : {}),
});
const step = (frame: string, extra: Partial<RecordingStep> = {}) => ({
  title: `on ${frame}`,
  startMs: 0,
  durationMs: 1,
  frame,
  ...extra,
});

describe("summarizeRun", () => {
  test("one thumbnail per run of steps on the same frame; the failing one wins", () => {
    const run = summarizeRun(
      manifest([
        step("a"),
        step("a", { title: "fail", error: "boom" }),
        step("a", { title: "after" }),
        step("b", { repeat: 4 }),
      ]),
      "/d",
    );
    expect(run.strip.map((f) => [f.frame, f.title, f.step])).toEqual([
      ["a", "fail", 2],
      ["b", "on b", 4],
    ]);
    expect(run).toMatchObject({ calls: 7, steps: 4, failed: 1, frames: 2 });
    expect(run.stripGap).toBeNull();
  });

  test("past the cap: the first and last halves, the gap named, omitted calls counted", () => {
    const steps = Array.from({ length: 10 }, (_, i) => step(`f${i}`));
    const run = summarizeRun(manifest(steps, { at: 5, calls: 100 }), "/d", 4);
    expect(run.strip.map((f) => f.frame)).toEqual(["f0", "f1", "f8", "f9"]);
    expect(run.stripGap).toEqual({ at: 2, frames: 6 });
    expect(run).toMatchObject({ calls: 110, omittedCalls: 100, frames: 10 });
  });
});
