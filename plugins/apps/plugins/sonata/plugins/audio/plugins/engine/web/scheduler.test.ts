import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildTempoIndex,
  emptyScore,
  retempoTimeline,
  songPosition,
  startTimeline,
  type LoopCycle,
  type PlayPosition,
  type PlaybackTimeline,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { TimelineStore } from "@plugins/apps/plugins/sonata/plugins/session/web";

type TimelineState = ReturnType<TimelineStore["get"]>;
import type {
  InstrumentVoices,
  ScheduledNote,
} from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";
import { LATE_DROP_SEC, startScheduling } from "./scheduler";

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

function recorder() {
  const played: ScheduledNote[] = [];
  let offs = 0;
  const voices = {
    schedule: (n: ScheduledNote) => played.push(n),
    allOff: () => {
      offs++;
    },
  } as unknown as InstrumentVoices;
  return { played, offs: () => offs, resolve: () => voices };
}

/** A timeline store the test writes, standing in for the session's. */
function store() {
  let state: TimelineState = { kind: "idle" };
  let generation = 0;
  const listeners = new Set<() => void>();
  const set = (next: TimelineState) => {
    state = next;
    for (const l of [...listeners]) l();
  };
  const timelines: TimelineStore = {
    get: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    timelines,
    /** A new path from `from` (a song beat, or a whole position), now. */
    start(
      from: number | PlayPosition,
      cycle: LoopCycle | null = null,
      bpm = 120,
    ) {
      set({
        kind: "running",
        generation: ++generation,
        timeline: startTimeline(
          typeof from === "number" ? songPosition(from) : from,
          cycle,
          tempoAt(bpm),
          ctx.currentTime,
        ),
      });
    },
    /** The same path at a new tempo from now. */
    retempo(bpm: number) {
      if (state.kind !== "running") throw new Error("not running");
      set({
        ...state,
        timeline: retempoTimeline(
          state.timeline,
          tempoAt(bpm),
          ctx.currentTime,
        ),
      });
    },
    idle: () => set({ kind: "idle" }),
    current(): PlaybackTimeline {
      if (state.kind !== "running") throw new Error("not running");
      return state.timeline;
    },
  };
}

const tempoAt = (bpm: number) =>
  buildTempoIndex({ ...emptyScore(), tempoMap: [{ beat: 0, bpm }] });

describe("startScheduling", () => {
  it("places every note where the timeline says, and nothing while idle", () => {
    const r = recorder();
    const s = store();
    const h = startScheduling(song(8), s.timelines, r.resolve, ctx);
    runTo(1);
    expect(r.played).toEqual([]);
    s.start(2);
    runTo(3);
    // Beat 2 sounds at t = 1, then one note every half second.
    expect(r.played.map((n) => [n.pitch, n.when])).toEqual([
      [62, 1],
      [63, 1.5],
      [64, 2],
      [65, 2.5],
      [66, 3],
    ]);
    h.cancel();
  });

  it("restarts on a new path, silencing what rang", () => {
    const r = recorder();
    const s = store();
    const h = startScheduling(song(8), s.timelines, r.resolve, ctx);
    s.start(0);
    runTo(1);
    const offs = r.offs();
    s.start(5);
    expect(r.offs()).toBe(offs + 1);
    runTo(1.6);
    expect(r.played.map((n) => n.pitch).slice(-2)).toEqual([65, 66]);
    s.idle();
    expect(r.offs()).toBe(offs + 2);
    const n = r.played.length;
    runTo(5);
    expect(r.played.length).toBe(n);
    h.cancel();
  });

  it("drops the notes a late join would play late, instead of bursting them", () => {
    const r = recorder();
    const s = store();
    s.start(0);
    // The scheduler joins 1.02 s in (instruments loading): beats 0 and 1 are
    // gone; beat 2 (20 ms late) still plays.
    runTo(1.02);
    const h = startScheduling(song(8), s.timelines, r.resolve, ctx);
    expect(r.played.map((n) => n.pitch)).toEqual([62]);
    expect(LATE_DROP_SEC).toBeGreaterThan(0.02);
    h.cancel();
  });

  it("re-times on a tempo change without re-triggering or cutting a note", () => {
    const r = recorder();
    const s = store();
    const h = startScheduling(song(8), s.timelines, r.resolve, ctx);
    s.start(0);
    runTo(1.02); // beats 0, 1, 2 handed over
    const offs = r.offs();
    s.retempo(60); // a beat a second from here
    runTo(3);
    expect(r.offs()).toBe(offs);
    const pitches = r.played.map((n) => n.pitch);
    expect(new Set(pitches).size).toBe(pitches.length);
    // At t = 1.02 the music was at beat 2.04: beat 3 is 0.96 beats on.
    expect(r.played.find((n) => n.pitch === 63)?.when).toBeCloseTo(1.98, 9);
    h.cancel();
  });

  it("stays on the cursor's timeline through a loop and a long speed drag", () => {
    // The bug this design removes: the sound and the cursor each kept their own
    // anchor, and every tempo change lost the cursor the time since its last
    // frame. Now every note must sound exactly where the shared timeline puts
    // its beat — once per iteration, in order — however many changes land.
    const r = recorder();
    const s = store();
    const h = startScheduling(song(16), s.timelines, r.resolve, ctx);
    const dispatched: {
      c: number;
      when: number;
      pitch: number;
      tl: PlaybackTimeline;
    }[] = [];
    const schedule = r.resolve().schedule.bind(r.resolve());
    (r.resolve() as { schedule: (n: ScheduledNote) => void }).schedule = (
      n,
    ) => {
      const tl = s.current();
      dispatched.push({ c: tl.cAt(n.when), when: n.when, pitch: n.pitch, tl });
      schedule(n);
    };
    s.start(2, { start: 4, end: 8, rest: 0 });
    let bpm = 120;
    for (let i = 0; i < 300; i++) {
      runTo(ctx.currentTime + 0.02 + ((i * 7919) % 17) / 1000);
      bpm = 50 + ((i * 37) % 120);
      s.retempo(bpm);
    }
    runTo(ctx.currentTime + 1);
    expect(dispatched.length).toBeGreaterThan(14); // head + 2 loop passes
    for (const [i, d] of dispatched.entries()) {
      // The path coordinates are whole beats, one after another: no note is
      // skipped, doubled or shifted by the changes.
      expect(d.c).toBeCloseTo(i, 6);
      // And it sounds where the cursor reaches its beat.
      expect(d.tl.timeAt(d.c)).toBeCloseTo(d.when, 9);
      // The head (beats 2–7), then beats 4–7 over and over.
      expect(d.pitch).toBe(60 + (i < 6 ? 2 + i : 4 + ((i - 6) % 4)));
    }
    h.cancel();
  });
});

describe("startScheduling: a loop's rest", () => {
  // Loop [4, 8) with a 2-beat rest: each iteration is [2, 8) — 6 beats, 3 s.
  const cycle: LoopCycle = { start: 4, end: 8, rest: 2 };

  it("rests before every repeat, sounding only the body", () => {
    const r = recorder();
    const s = store();
    const h = startScheduling(song(16), s.timelines, r.resolve, ctx);
    s.start(4, cycle);
    runTo(8);
    // First pass: beats 4..7 at 0, 0.5, 1, 1.5 s. Then 1 s of rest (the
    // span of beats 2..3 stays silent) and the body again from 3 s.
    expect(r.played.slice(0, 8).map((n) => [n.pitch, n.when])).toEqual([
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

  it("resumes a position paused inside the rest with the rest's remainder", () => {
    const r = recorder();
    const s = store();
    const h = startScheduling(song(16), s.timelines, r.resolve, ctx);
    // Paused one beat before A: A sounds 0.5 s after resuming.
    s.start({ beat: 4, rest: 1, repeat: true }, cycle);
    runTo(1);
    expect(r.played[0]).toMatchObject({ pitch: 64 });
    expect(r.played[0]?.when).toBeCloseTo(0.5, 9);
    h.cancel();
  });

  it("sounds the rest's span when asked (the metronome counting through it)", () => {
    const r = recorder();
    const s = store();
    const h = startScheduling(song(16), s.timelines, r.resolve, ctx, {
      restSounds: true,
    });
    s.start(4, cycle);
    runTo(4);
    const restClicks = r.played.filter((n) => n.when >= 2 && n.when < 3);
    expect(restClicks.map((n) => n.pitch)).toEqual([62, 63]);
    h.cancel();
  });
});
