import { describe, expect, it } from "bun:test";
import { buildTempoIndex } from "./tempo-index";
import { emptyScore } from "./helpers";
import { songPosition } from "./loop-cycle";
import type { LoopCycle, Score } from "./types";
import {
  rebaseTimeline,
  resyncTimeline,
  retempoTimeline,
  startTimeline,
} from "./timeline";

const tempo = (map: Score["tempoMap"]) =>
  buildTempoIndex({ ...emptyScore(), tempoMap: map });
/** 120 bpm: half a second a beat. */
const t120 = tempo([{ beat: 0, bpm: 120 }]);
/** 60 bpm: a second a beat. */
const t60 = tempo([{ beat: 0, bpm: 60 }]);
/** A seamless (rest-free) loop. */
const loop = (start: number, end: number): LoopCycle => ({
  start,
  end,
  rest: 0,
});

describe("startTimeline", () => {
  it("plays straight through without a loop", () => {
    const tl = startTimeline(songPosition(2), null, t120, 10);
    expect(tl.positionAt(10).beat).toBe(2);
    expect(tl.positionAt(11).beat).toBe(4);
    expect(tl.timeAt(tl.cAt(13.7))).toBeCloseTo(13.7, 9);
    expect(tl.iterationOf(tl.cAt(100))).toBe(0);
  });

  it("runs the head into the loop, then folds every iteration back to A", () => {
    // Head [1, 4) = 1.5 s, loop [2, 4) = 1 s an iteration.
    const tl = startTimeline(songPosition(1), loop(2, 4),
      t120,
      0,
    );
    expect(tl.positionAt(1).beat).toBeCloseTo(3, 9);
    expect(tl.iterationOf(tl.cAt(1))).toBe(0);
    expect(tl.positionAt(1.5).beat).toBeCloseTo(2, 9);
    expect(tl.iterationOf(tl.cAt(1.5))).toBe(1);
    expect(tl.positionAt(2.25).beat).toBeCloseTo(3.5, 9);
    expect(tl.positionAt(2.5).beat).toBeCloseTo(2, 9);
    expect(tl.iterationOf(tl.cAt(2.5))).toBe(2);
    // A note's place in iteration k is where the cursor reaches it.
    expect(tl.timeAt(tl.loopC(2, 3))).toBeCloseTo(3, 9);
    expect(tl.positionAt(3).beat).toBeCloseTo(3, 9);
  });

  it("is exact under a tempo map that changes inside the loop", () => {
    const varying = tempo([
      { beat: 0, bpm: 120 },
      { beat: 3, bpm: 60 },
    ]);
    // Loop [2, 4): beat 2→3 is 0.5 s, 3→4 is 1 s.
    const tl = startTimeline(songPosition(2), loop(2, 4),
      varying,
      0,
    );
    for (const t of [0.25, 0.5, 1, 1.4, 1.5, 2, 2.9, 4.6]) {
      expect(tl.timeAt(tl.cAt(t))).toBeCloseTo(t, 9);
    }
    expect(tl.positionAt(1.5).beat).toBeCloseTo(2, 9);
    expect(tl.positionAt(2).beat).toBeCloseTo(3, 9);
  });

  it("starts a path at or past B on a repeat", () => {
    const tl = startTimeline(songPosition(5), loop(2, 4), t120, 0);
    expect(tl.positionAt(0)).toEqual({ beat: 2, rest: 0, repeat: true });
    expect(tl.path.origin).toBe(2);
  });
});

describe("retempoTimeline", () => {
  it("keeps what sounds at the change instant, and re-times what follows", () => {
    const tl = startTimeline(songPosition(0), loop(0, 4),
      t120,
      0,
    );
    const at = 2.7; // beat 1.4 of iteration 2
    const slow = retempoTimeline(tl, t60, at);
    expect(slow.positionAt(at).beat).toBeCloseTo(tl.positionAt(at).beat, 9);
    expect(slow.cAt(at)).toBeCloseTo(tl.cAt(at), 9);
    // One second later at 60 bpm: one beat on.
    expect(slow.positionAt(at + 1).beat).toBeCloseTo(2.4, 9);
  });

  it("never loses time over many changes (the drift a sampled cursor had)", () => {
    let tl = startTimeline(songPosition(0), loop(0, 8),
      t120,
      0,
    );
    let expected = 0; // beats walked, integrated by hand
    let t = 0;
    let bpm = 120;
    for (let i = 0; i < 200; i++) {
      const dt = 0.003 + ((i * 7919) % 13) / 1000;
      expected += (dt * bpm) / 60;
      t += dt;
      bpm = 40 + ((i * 31) % 100);
      tl = retempoTimeline(tl, tempo([{ beat: 0, bpm }]), t);
    }
    expect(tl.cAt(t)).toBeCloseTo(expected, 6);
  });
});

describe("resyncTimeline", () => {
  it("moves the position without changing the path or the tempo", () => {
    const tl = startTimeline(songPosition(0), null, t120, 0);
    const moved = resyncTimeline(tl, 5, 2);
    expect(moved.positionAt(2).beat).toBe(5);
    expect(moved.positionAt(3).beat).toBe(7);
    expect(moved.path).toBe(tl.path);
  });

  it("lands inside the loop iteration nearest the current one", () => {
    const tl = startTimeline(songPosition(0), loop(0, 4),
      t120,
      0,
    );
    // At t = 5.9 s: loop iteration 2, beat 3.8. The medium says beat 0.1 — the next
    // iteration's start, just ahead.
    const moved = resyncTimeline(tl, 0.1, 5.9);
    expect(moved.positionAt(5.9).beat).toBeCloseTo(0.1, 9);
    expect(moved.iterationOf(moved.cAt(5.9))).toBe(3);
  });
});

describe("rebaseTimeline", () => {
  it("carries the position onto another clock", () => {
    const tl = startTimeline(songPosition(0), null, t120, 100);
    const moved = rebaseTimeline(tl, 101, 7);
    expect(moved.positionAt(7).beat).toBeCloseTo(2, 9);
    expect(moved.positionAt(8).beat).toBeCloseTo(4, 9);
  });
});

describe("a loop's rest", () => {
  // Loop [8, 12) resting 4 beats before every repeat: an iteration is [4, 12),
  // 8 s at 60 bpm.
  const cycle: LoopCycle = { start: 8, end: 12, rest: 4 };

  it("plays the song (including the bar the rest replaces) on the first pass", () => {
    const tl = startTimeline(songPosition(0), cycle, t60, 0);
    expect(tl.positionAt(5)).toEqual(songPosition(5));
    expect(tl.positionAt(9)).toEqual(songPosition(9));
  });

  it("rests before every repeat, parked on A with the rest counting down", () => {
    const tl = startTimeline(songPosition(0), cycle, t60, 0);
    expect(tl.positionAt(12)).toEqual({ beat: 8, rest: 4, repeat: true });
    expect(tl.iterationOf(tl.cAt(12))).toBe(1);
    expect(tl.positionAt(15)).toEqual({ beat: 8, rest: 1, repeat: true });
    expect(tl.positionAt(16)).toEqual({ beat: 8, rest: 0, repeat: true });
    expect(tl.positionAt(18)).toEqual({ beat: 10, rest: 0, repeat: true });
    expect(tl.positionAt(20)).toEqual({ beat: 8, rest: 4, repeat: true });
    expect(tl.iterationOf(tl.cAt(20))).toBe(2);
  });

  it("times the rest with the tempo in force before A", () => {
    // 120 bpm up to beat 8, 60 bpm after: the rest [4, 8) takes 2 s.
    const idx = tempo([
      { beat: 0, bpm: 120 },
      { beat: 8, bpm: 60 },
    ]);
    const tl = startTimeline(songPosition(0), cycle, idx, 0);
    const endSec = idx.beatToSeconds(12); // 4 + 4 = 8 s
    expect(tl.positionAt(endSec + 1)).toEqual({
      beat: 8,
      rest: 2,
      repeat: true,
    });
    expect(tl.positionAt(endSec + 2).rest).toBe(0);
  });

  it("resumes a position paused inside the rest with the rest's remainder", () => {
    const tl = startTimeline({ beat: 8, rest: 3, repeat: true }, cycle, t60, 0);
    expect(tl.positionAt(0)).toEqual({ beat: 8, rest: 3, repeat: true });
    expect(tl.positionAt(3)).toEqual({ beat: 8, rest: 0, repeat: true });
    // B, then the next iteration's whole rest.
    expect(tl.positionAt(7)).toEqual({ beat: 8, rest: 4, repeat: true });
  });

  it("resumes a repeat pass as a repeat", () => {
    const tl = startTimeline({ beat: 10, rest: 0, repeat: true }, cycle, t60, 0);
    expect(tl.positionAt(1)).toEqual({ beat: 11, rest: 0, repeat: true });
  });

  it("reads a position the cycle cannot hold as its song beat", () => {
    const off = startTimeline({ beat: 2, rest: 0, repeat: true }, cycle, t60, 0);
    expect(off.positionAt(0)).toEqual(songPosition(2));
    const none = startTimeline({ beat: 8, rest: 2, repeat: true }, null, t60, 0);
    expect(none.positionAt(0)).toEqual(songPosition(8));
  });
});
