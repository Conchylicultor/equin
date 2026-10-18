import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  emptyScore,
  type Note,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { usePerformedScore } from "../use-performed-score";

let swingFallingNotes = true;
vi.mock("@plugins/config_v2/web", () => ({
  useConfig: () => ({ swingFallingNotes }),
}));

function note(id: string, start: number): Note {
  return { id, pitch: 60, start, duration: 0.5, velocity: 80, track: "t" };
}

function score(swing: Score["meta"]["swing"]): Score {
  return {
    ...emptyScore(),
    meta: { swing },
    notes: [note("on", 0), note("off", 0.5)],
  };
}

describe("usePerformedScore", () => {
  it("swings the off-beats when the toggle is on", () => {
    swingFallingNotes = true;
    const { result } = renderHook(() =>
      usePerformedScore(score({ unit: 8, ratio: 2 })),
    );
    const [on, off] = result.current.notes;
    expect(on?.start).toBe(0);
    expect(off?.start).toBeCloseTo(2 / 3);
  });

  it("returns the straight score when the toggle is off", () => {
    swingFallingNotes = false;
    const s = score({ unit: 8, ratio: 2 });
    const { result } = renderHook(() => usePerformedScore(s));
    expect(result.current).toBe(s);
  });

  it("keeps a straight song's identity", () => {
    swingFallingNotes = true;
    const s = score(undefined);
    const { result } = renderHook(() => usePerformedScore(s));
    expect(result.current).toBe(s);
  });
});
