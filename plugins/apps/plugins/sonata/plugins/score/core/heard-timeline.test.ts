import { describe, expect, it } from "bun:test";
import { buildTempoIndex } from "./tempo-index";
import { emptyScore } from "./helpers";
import { songPosition } from "./loop-cycle";
import { createHeardTimeline } from "./heard-timeline";
import { retempoTimeline, startTimeline } from "./timeline";

/** 120 bpm: half a second a beat. */
const t120 = buildTempoIndex({
  ...emptyScore(),
  tempoMap: [{ beat: 0, bpm: 120 }],
});
/** 60 bpm: a second a beat. */
const t60 = buildTempoIndex({
  ...emptyScore(),
  tempoMap: [{ beat: 0, bpm: 60 }],
});

const beatAt = (h: ReturnType<typeof createHeardTimeline>, t: number) => {
  const r = h.read(t);
  if (r === null) throw new Error("nothing heard");
  return r.timeline.beatOf(r.c);
};

describe("createHeardTimeline", () => {
  it("reads nothing until a timeline is pushed, and after a clear", () => {
    const h = createHeardTimeline();
    expect(h.read(0)).toBeNull();
    h.push(startTimeline(songPosition(0), null, t120, 0), 0, "jump");
    expect(h.read(1)).not.toBeNull();
    h.clear();
    expect(h.read(1)).toBeNull();
  });

  it("holds at a timeline's start until it takes over", () => {
    const h = createHeardTimeline();
    h.push(startTimeline(songPosition(4), null, t120, 10), 10, "jump");
    expect(beatAt(h, 9.8)).toBe(4);
    expect(beatAt(h, 11)).toBeCloseTo(6, 9);
  });

  it("reads a continued timeline's predecessor until the takeover is heard", () => {
    const h = createHeardTimeline();
    const before = startTimeline(songPosition(0), null, t120, 0);
    h.push(before, 0, "jump");
    h.push(retempoTimeline(before, t60, 1), 1, "continue"); // beat 2 at t = 1
    expect(beatAt(h, 0.9)).toBeCloseTo(1.8, 9); // 120 bpm
    expect(beatAt(h, 1)).toBeCloseTo(2, 9); // no step at the takeover
    expect(beatAt(h, 1.3)).toBeCloseTo(2.3, 9); // 60 bpm
  });

  it("drops the predecessors on a jump", () => {
    const h = createHeardTimeline();
    h.push(startTimeline(songPosition(0), null, t120, 0), 0, "jump");
    h.push(startTimeline(songPosition(10), null, t120, 1), 1, "jump");
    expect(beatAt(h, 0.9)).toBe(10);
  });

  it("forgets what is no longer heard", () => {
    const h = createHeardTimeline();
    const first = startTimeline(songPosition(0), null, t120, 0);
    h.push(first, 0, "jump");
    h.push(retempoTimeline(first, t60, 1), 1, "continue");
    expect(beatAt(h, 1.5)).toBeCloseTo(2.5, 9);
    // Read past the takeover once: the predecessor is gone, so an earlier
    // instant now holds at the successor's start.
    expect(beatAt(h, 0.5)).toBeCloseTo(2, 9);
  });

  it("a takeover earlier than the newest replaces the later ones", () => {
    const h = createHeardTimeline();
    const first = startTimeline(songPosition(0), null, t120, 0);
    h.push(first, 0, "jump");
    h.push(retempoTimeline(first, t60, 2), 2, "continue");
    h.push(retempoTimeline(first, t120, 1), 1, "continue");
    expect(beatAt(h, 3)).toBeCloseTo(6, 9); // still 120 bpm: the 60 bpm entry went
  });
});
