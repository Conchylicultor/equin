import { describe, expect, it } from "bun:test";
import { emptyScore } from "./helpers";
import { buildTempoIndex } from "./tempo-index";
import { songPosition } from "./loop-cycle";
import { startTimeline } from "./timeline";
import { songAxis, unrollLoop } from "./loop-timeline";
import type { LoopCycle, Note, Score } from "./types";

const note = (id: string, start: number, duration = 1): Note => ({
  id,
  pitch: 60,
  start,
  duration,
  velocity: 90,
  track: "t",
});

// A, B, C, D, E, F — one bar (4 beats) each, at 60 bpm.
const song: Score = {
  ...emptyScore(),
  tempoMap: [{ beat: 0, bpm: 60 }],
  timeSigMap: [{ beat: 0, numerator: 4, denominator: 4 }],
  notes: ["a", "b", "c", "d", "e", "f"].map((id, i) => note(id, i * 4)),
};
// Loop [C D] with a one-bar rest.
const cycle: LoopCycle = { start: 8, end: 16, rest: 4 };

describe("unrollLoop", () => {
  const axis = unrollLoop(song, cycle);
  const ids = (from: number, to: number) =>
    axis.score.notes
      .filter((n) => n.start >= from && n.start < to)
      .map((n) => n.id.split("~")[0]);

  it("keeps the song up to B, then repeats [rest][C D]", () => {
    expect(ids(0, 16)).toEqual(["a", "b", "c", "d"]);
    // First copy: the rest bar [16, 20) is empty, then C D.
    expect(ids(16, 20)).toEqual([]);
    expect(ids(20, 28)).toEqual(["c", "d"]);
    // Second copy, and never E / F.
    expect(ids(28, 32)).toEqual([]);
    expect(ids(32, 40)).toEqual(["c", "d"]);
    expect(axis.score.notes.some((n) => n.id === "e" || n.id === "f")).toBe(
      false,
    );
  });

  it("gives every copied note its own id", () => {
    const seen = new Set(axis.score.notes.map((n) => n.id));
    expect(seen.size).toBe(axis.score.notes.length);
  });

  it("draws enough copies for the song's own span", () => {
    const shifts = axis.timeline.loop!.shifts;
    expect(shifts[0]).toBe(12);
    expect(shifts[1]).toBe(24);
    expect(shifts.length * 12).toBeGreaterThanOrEqual(128);
  });

  it("keeps the axis time equal to the transport's time", () => {
    const axisTempo = buildTempoIndex(axis.score);
    const tempo = buildTempoIndex(song);
    // Wherever the transport is, its axis beat sits at the same elapsed time
    // as on the transport, measured from the song's start.
    const transport = startTimeline(songPosition(0), cycle, tempo, 0);
    for (const raw of [2, 10, 16, 18.5, 22, 27, 30, 35]) {
      const position = transport.positionAt(raw);
      const iter = transport.iterationOf(transport.cAt(raw));
      const u = axis.timeline.axisBeat(position);
      // On a repeat the cursor sits in the first copy: one cycle per extra
      // iteration has been folded away.
      const folded = raw - Math.max(0, iter - 1) * 12;
      expect(axisTempo.beatToSeconds(u)).toBeCloseTo(folded, 9);
    }
  });

  it("places the cursor continuously from the first pass into the first repeat", () => {
    const { timeline } = axis;
    expect(timeline.axisBeat({ beat: 15.99, rest: 0, repeat: false })).toBe(
      15.99,
    );
    expect(timeline.axisBeat({ beat: 8, rest: 4, repeat: true })).toBe(16);
    expect(timeline.axisBeat({ beat: 8, rest: 1, repeat: true })).toBe(19);
    expect(timeline.axisBeat({ beat: 8, rest: 0, repeat: true })).toBe(20);
    expect(timeline.axisBeat({ beat: 12, rest: 0, repeat: true })).toBe(24);
  });

  it("reads an axis beat back as the play position shown there", () => {
    const { timeline } = axis;
    expect(timeline.at(6)).toEqual({ beat: 6, rest: 0, repeat: false });
    expect(timeline.at(17)).toEqual({ beat: 8, rest: 3, repeat: true });
    expect(timeline.at(22)).toEqual({ beat: 10, rest: 0, repeat: true });
    expect(timeline.at(34)).toEqual({ beat: 10, rest: 0, repeat: true });
    for (const u of [16, 19, 21.5, 27]) {
      expect(timeline.axisBeat(timeline.at(u))).toBeCloseTo(u, 9);
    }
  });

  it("opens each rest with an unnumbered bar line and keeps the loop's bar numbers", () => {
    const lines = axis.bars.filter(
      (x) => x.startBeat >= 16 && x.startBeat < 30,
    );
    expect(lines).toEqual([
      { index: null, startBeat: 16 },
      { index: 2, startBeat: 20 },
      { index: 3, startBeat: 24 },
      { index: null, startBeat: 28 },
    ]);
  });

  it("clips annotations to the loop body and copies them", () => {
    const s: Score = {
      ...song,
      annotations: [
        {
          type: "chord",
          start: 6,
          end: 18,
          data: { symbol: "C", root: 0, quality: "maj" },
          source: "authored",
        },
      ],
    };
    const a = unrollLoop(s, cycle).score.annotations;
    expect(a[0]).toMatchObject({ start: 6, end: 16 });
    expect(a[1]).toMatchObject({ start: 20, end: 28 });
  });

  it("copies the body's pedal, clipped to the loop", () => {
    const s: Score = {
      ...song,
      pedalEvents: [
        { track: "t", beat: 6, down: true },
        { track: "t", beat: 10, down: false },
      ],
    };
    const p = unrollLoop(s, cycle).score.pedalEvents.filter(
      (e) => e.beat >= 16 && e.beat < 28,
    );
    expect(p).toEqual([
      { track: "t", beat: 20, down: true },
      { track: "t", beat: 22, down: false },
    ]);
  });

  it("with no rest, copies follow B directly", () => {
    const seamless = unrollLoop(song, { start: 8, end: 16, rest: 0 });
    expect(
      seamless.score.notes
        .filter((n) => n.start >= 16 && n.start < 32)
        .map((n) => [n.id.split("~")[0], n.start]),
    ).toEqual([
      ["c", 16],
      ["d", 20],
      ["c", 24],
      ["d", 28],
    ]);
  });
});

describe("songAxis", () => {
  it("is the score as written", () => {
    const axis = songAxis(song);
    expect(axis.score).toBe(song);
    expect(axis.timeline.loop).toBeNull();
    expect(axis.timeline.axisBeat({ beat: 9, rest: 2, repeat: true })).toBe(9);
  });
});
