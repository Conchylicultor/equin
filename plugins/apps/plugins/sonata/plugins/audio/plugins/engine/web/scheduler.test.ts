import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  emptyScore,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import type {
  InstrumentVoices,
  ScheduledNote,
} from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";
import { RESYNC_LATE_SEC, startScheduling } from "./scheduler";

// A fake audio clock: the test sets `currentTime` and fires the scheduler's
// wake-up node by hand (`wake`), as the audio thread would at its stop time.
class FakeConstantSource {
  onended: (() => void) | null = null;
  constructor() {
    nodes.push(this);
  }
  connect(): void {}
  disconnect(): void {}
  start(): void {}
  stop(): void {}
}
let nodes: FakeConstantSource[] = [];
const ctx = { currentTime: 0, destination: {} } as unknown as AudioContext & {
  currentTime: number;
};
const original = (globalThis as { ConstantSourceNode?: unknown })
  .ConstantSourceNode;

beforeEach(() => {
  nodes = [];
  ctx.currentTime = 0;
  (globalThis as { ConstantSourceNode?: unknown }).ConstantSourceNode =
    FakeConstantSource;
});
afterEach(() => {
  (globalThis as { ConstantSourceNode?: unknown }).ConstantSourceNode =
    original;
});

/** Advance the audio clock to `t` in 20 ms wake-ups, as the ticker would. */
function runTo(t: number) {
  while (ctx.currentTime < t - 1e-9) {
    ctx.currentTime = Math.min(t, ctx.currentTime + 0.02);
    const node = nodes.at(-1);
    node?.onended?.();
  }
}

/** 120 bpm (0.5 s a beat), one note on every beat over `[0, beats)`. */
function song(beats: number): Score {
  return {
    ...emptyScore(),
    tracks: [{ id: "t" }],
    tempoMap: [{ beat: 0, bpm: 120 }],
    notes: Array.from({ length: beats }, (_, i) => ({
      id: `n${i}`,
      pitch: 60 + i,
      start: i,
      duration: 1,
      velocity: 80,
      track: "t",
    })),
  };
}

/** A schedule origin on the song's own pass. */
const at = (beat: number) => ({ beat, rest: 0 });

function recorder() {
  const played: ScheduledNote[] = [];
  const voices = {
    schedule: (n: ScheduledNote) => played.push(n),
  } as unknown as InstrumentVoices;
  return { played, resolve: () => voices };
}

describe("startScheduling: beatAt", () => {
  it("is the beat sounding at an audio time", () => {
    const r = recorder();
    const h = startScheduling(song(16), at(2), 10, r.resolve, ctx);
    expect(h.beatAt(10)).toBeCloseTo(2, 9);
    expect(h.beatAt(11)).toBeCloseTo(4, 9);
    h.cancel();
  });

  it("folds an A–B loop's iterations", () => {
    const r = recorder();
    const h = startScheduling(song(16), at(0), 0, r.resolve, ctx, {
      start: 4,
      end: 8,
      rest: 0,
    });
    // Head runs 0..8 (4 s), then each iteration is 4 beats (2 s).
    expect(h.beatAt(4)).toBeCloseTo(0 + 8, 9); // the boundary itself
    expect(h.beatAt(4.5)).toBeCloseTo(5, 9);
    expect(h.beatAt(7)).toBeCloseTo(6, 9);
    h.cancel();
  });
});

describe("startScheduling: resync", () => {
  it("re-anchors so the given beat sounds at the given time", () => {
    const r = recorder();
    const h = startScheduling(song(16), at(0), 0, r.resolve, ctx);
    runTo(1);
    // The medium says beat 2.2 at t = 1 (the synth was 100 ms behind).
    h.resync(2.2, 1);
    expect(h.beatAt(1)).toBeCloseTo(2.2, 9);
    runTo(3);
    const n3 = r.played.find((n) => n.pitch === 63);
    expect(n3?.when).toBeCloseTo(1 + 0.4, 9);
    h.cancel();
  });

  it("never re-triggers a note when moved back, and drops what a jump forward left far behind", () => {
    const r = recorder();
    const h = startScheduling(song(16), at(0), 0, r.resolve, ctx);
    runTo(1.02);
    const before = r.played.map((n) => n.pitch);
    expect(before).toEqual([60, 61, 62]);

    // Back 60 ms: beat 2 was already handed over — it is not played again.
    h.resync(1.92, 1.02);
    runTo(1.6);
    const pitches = r.played.map((n) => n.pitch);
    expect(pitches.filter((p) => p === 62).length).toBe(1);

    // Forward 1.2 beats (600 ms): beat 4 would be 500 ms late → dropped.
    // Beat 5 still lies ahead and sounds on the new anchor.
    const t = ctx.currentTime;
    const beat = h.beatAt(t);
    h.resync(beat + 1.2, t);
    runTo(t + 1);
    expect(r.played.some((n) => n.pitch === 64)).toBe(false);
    const n5 = r.played.find((n) => n.pitch === 65);
    expect(n5?.when).toBeGreaterThan(t - RESYNC_LATE_SEC);
    h.cancel();
  });

  it("lands in the loop iteration nearest the current one", () => {
    const r = recorder();
    const h = startScheduling(song(16), at(4), 0, r.resolve, ctx, {
      start: 4,
      end: 8,
      rest: 0,
    });
    // The head (2 s) and one pass (2 s) in: the second pass, at beat 4.4.
    runTo(4.2);
    h.resync(4.5, 4.2);
    expect(h.beatAt(4.2)).toBeCloseTo(4.5, 9);
    // The next note (beat 5) follows 0.25 s later — not a whole pass away.
    runTo(5);
    const next = r.played.filter((n) => n.when > 4.2 && n.pitch === 65);
    expect(next[0]?.when).toBeCloseTo(4.45, 9);
    h.cancel();
  });
});

describe("startScheduling: a loop's rest", () => {
  // Loop [4, 8) with a 2-beat rest: each iteration is [2, 8) — 6 beats, 3 s.
  const cycle = { start: 4, end: 8, rest: 2 };

  it("rests before every repeat, sounding only the body", () => {
    const r = recorder();
    const h = startScheduling(song(16), at(4), 0, r.resolve, ctx, cycle);
    runTo(8);
    // First pass: beats 4..7 at 0, 0.5, 1, 1.5 s. Then 1 s of rest (the
    // span of beats 2..3 stays silent) and the body again from 3 s.
    const firstNotes = r.played.map((n) => [n.pitch, n.when]);
    expect(firstNotes.slice(0, 8)).toEqual([
      [64, 0],
      [65, 0.5],
      [66, 1],
      [67, 1.5],
      [64, 3],
      [65, 3.5],
      [66, 4],
      [67, 4.5],
    ]);
    expect(r.played.some((n) => n.pitch === 62 || n.pitch === 63)).toBe(false);
    h.cancel();
  });

  it("resumes a cursor paused inside the rest with the rest's remainder", () => {
    const r = recorder();
    // Paused one beat before A: A sounds 0.5 s after resuming.
    const h = startScheduling(
      song(16),
      { beat: 4, rest: 1 },
      0,
      r.resolve,
      ctx,
      cycle,
    );
    runTo(1);
    expect(r.played[0]).toMatchObject({ pitch: 64 });
    expect(r.played[0]?.when).toBeCloseTo(0.5, 9);
    h.cancel();
  });

  it("sounds the rest's span when asked (the metronome counting through it)", () => {
    const r = recorder();
    const h = startScheduling(song(16), at(4), 0, r.resolve, ctx, cycle, {
      restSounds: true,
    });
    runTo(4);
    const restClicks = r.played.filter((n) => n.when >= 2 && n.when < 3);
    expect(restClicks.map((n) => n.pitch)).toEqual([62, 63]);
    h.cancel();
  });
});
