import { describe, expect, it } from "bun:test";
import {
  barBeatsAt,
  cycleBeats,
  cycleStart,
  positionAtTime,
  songPosition,
  timeOfPosition,
} from "./loop-cycle";
import { emptyScore } from "./helpers";
import { buildTempoIndex } from "./tempo-index";
import type { LoopCycle, Score } from "./types";

// 60 bpm: one beat is one second, so seconds and beats read the same.
const score60: Score = { ...emptyScore(), tempoMap: [{ beat: 0, bpm: 60 }] };
const tempo = buildTempoIndex(score60);

describe("cycle geometry", () => {
  it("an iteration is the rest then the body", () => {
    const cycle: LoopCycle = { start: 8, end: 16, rest: 4 };
    expect(cycleStart(cycle)).toBe(4);
    expect(cycleBeats(cycle)).toBe(12);
  });
});

describe("barBeatsAt", () => {
  it("reads the meter in force at the beat", () => {
    const s: Score = {
      ...emptyScore(),
      timeSigMap: [
        { beat: 0, numerator: 4, denominator: 4 },
        { beat: 8, numerator: 6, denominator: 8 },
      ],
    };
    expect(barBeatsAt(s, 0)).toBe(4);
    expect(barBeatsAt(s, 7.9)).toBe(4);
    expect(barBeatsAt(s, 8)).toBe(3);
    expect(barBeatsAt(emptyScore(), 3)).toBe(4);
  });
});

describe("positionAtTime", () => {
  const cycle: LoopCycle = { start: 8, end: 12, rest: 4 }; // iteration = 8 s

  it("is the song position with no cycle", () => {
    expect(positionAtTime(5, null, tempo)).toEqual({
      position: songPosition(5),
      iter: 0,
    });
  });

  it("plays the song (including the bar the rest replaces) on the first pass", () => {
    expect(positionAtTime(5, cycle, tempo).position).toEqual(songPosition(5));
    expect(positionAtTime(9, cycle, tempo).position).toEqual(songPosition(9));
  });

  it("rests before every repeat, parked on A with the rest counting down", () => {
    // B (12 s) wraps into the rest: A with the whole rest to go.
    expect(positionAtTime(12, cycle, tempo)).toEqual({
      position: { beat: 8, rest: 4, repeat: true },
      iter: 1,
    });
    expect(positionAtTime(15, cycle, tempo).position).toEqual({
      beat: 8,
      rest: 1,
      repeat: true,
    });
    // The rest ends on A, then the body plays.
    expect(positionAtTime(16, cycle, tempo).position).toEqual({
      beat: 8,
      rest: 0,
      repeat: true,
    });
    expect(positionAtTime(18, cycle, tempo).position).toEqual({
      beat: 10,
      rest: 0,
      repeat: true,
    });
    // The next iteration rests again.
    expect(positionAtTime(20, cycle, tempo)).toEqual({
      position: { beat: 8, rest: 4, repeat: true },
      iter: 2,
    });
  });

  it("wraps seamlessly B→A with no rest", () => {
    const seamless: LoopCycle = { start: 8, end: 12, rest: 0 };
    expect(positionAtTime(12, seamless, tempo)).toEqual({
      position: { beat: 8, rest: 0, repeat: true },
      iter: 1,
    });
  });

  it("times the rest with the tempo in force before A", () => {
    // 120 bpm up to beat 8, 60 bpm after: the rest [4, 8) takes 2 s.
    const s: Score = {
      ...emptyScore(),
      tempoMap: [
        { beat: 0, bpm: 120 },
        { beat: 8, bpm: 60 },
      ],
    };
    const idx = buildTempoIndex(s);
    const endSec = idx.beatToSeconds(12); // 4 + 4 = 8 s
    expect(positionAtTime(endSec + 1, cycle, idx).position).toEqual({
      beat: 8,
      rest: 2,
      repeat: true,
    });
    expect(positionAtTime(endSec + 2, cycle, idx).position.rest).toBe(0);
  });
});

describe("timeOfPosition", () => {
  const cycle: LoopCycle = { start: 8, end: 12, rest: 4 };

  it("round-trips through positionAtTime", () => {
    for (const raw of [3, 9.5, 12, 14.25, 17, 19.9]) {
      const { position } = positionAtTime(raw, cycle, tempo);
      const back = positionAtTime(
        timeOfPosition(position, cycle, tempo),
        cycle,
        tempo,
      ).position;
      expect(back.beat).toBeCloseTo(position.beat, 9);
      expect(back.rest).toBeCloseTo(position.rest, 9);
      expect(back.repeat).toBe(position.repeat);
    }
  });

  it("resumes a paused rest inside the rest, not on the song before A", () => {
    const t = timeOfPosition({ beat: 8, rest: 3, repeat: true }, cycle, tempo);
    expect(positionAtTime(t, cycle, tempo).position).toEqual({
      beat: 8,
      rest: 3,
      repeat: true,
    });
  });

  it("reads a position the cycle cannot hold as its song beat", () => {
    expect(
      timeOfPosition({ beat: 30, rest: 0, repeat: true }, cycle, tempo),
    ).toBe(30);
    expect(
      timeOfPosition({ beat: 8, rest: 2, repeat: true }, null, tempo),
    ).toBe(8);
  });
});
