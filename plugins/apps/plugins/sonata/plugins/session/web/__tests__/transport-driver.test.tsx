import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  emptyScore,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { SonataSession } from "../slots";
import {
  CursorStoreProvider,
  useCursorApi,
  type CursorApi,
} from "../cursor-store";
import {
  PlaybackSession,
  useSession,
  type DriverState,
  type SessionValue,
  type TransportDriver,
} from "../session";

// Frames are run by hand: `frame()` fires every callback queued since the last.
let queued: FrameRequestCallback[] = [];
function frame() {
  const run = queued;
  queued = [];
  act(() => {
    for (const cb of run) cb(0);
  });
}
beforeEach(() => {
  queued = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queued.push(cb);
    return queued.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    queued = [];
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 4/4 at 120 bpm (half a second per beat), one note per beat over `[0, beats)`. */
function song(beats: number): Score {
  return {
    ...emptyScore(),
    tracks: [{ id: "t" }],
    tempoMap: [{ beat: 0, bpm: 120 }],
    timeSigMap: [{ beat: 0, numerator: 4, denominator: 4 }],
    notes: Array.from({ length: beats }, (_, i) => ({
      id: `n${i}`,
      pitch: 60,
      start: i,
      duration: 1,
      velocity: 80,
      track: "t",
    })),
  };
}

/** YouTube's rates: a request lands on the nearest one. */
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** A medium the test moves by hand. */
class FakeDriver implements TransportDriver {
  media = 0;
  state: DriverState = { kind: "paused" };
  calls: string[] = [];
  seeks: number[] = [];
  private listeners = new Set<(s: DriverState) => void>();

  position(): number | null {
    return this.state.kind === "advancing" ? this.media : null;
  }
  play(): void {
    this.calls.push("play");
  }
  pause(): void {
    this.calls.push("pause");
  }
  seek(mediaSec: number): void {
    this.seeks.push(mediaSec);
    this.media = mediaSec;
  }
  setRate(rate: number): Promise<number> {
    this.calls.push(`rate ${rate}`);
    const taken = RATES.reduce((a, b) =>
      Math.abs(b - rate) < Math.abs(a - rate) ? b : a,
    );
    return Promise.resolve(taken);
  }
  subscribe(listener: (s: DriverState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
  emit(state: DriverState): void {
    act(() => this.report(state));
  }
  /** Tell the listeners now, inside whatever act the caller is in. */
  report(state: DriverState): void {
    this.state = state;
    for (const l of this.listeners) l(state);
  }
}

const sessionPlugin: LoadedPlugin[] = [
  {
    id: "apps.sonata.session",
    description: "sonata session fixture",
    slots: SonataSession,
    contributions: [],
  } as unknown as LoadedPlugin,
];

function renderSession(score: Score) {
  let session: SessionValue | null = null;
  let cursor: CursorApi | null = null;
  function Probe() {
    session = useSession();
    cursor = useCursorApi();
    return null;
  }
  const content = { kind: "ready" as const, contentKey: {}, score };
  render(
    <PluginProvider plugins={sessionPlugin}>
      <CursorStoreProvider>
        <PlaybackSession content={content}>
          <Probe />
        </PlaybackSession>
      </CursorStoreProvider>
    </PluginProvider>,
  );
  const s = (): SessionValue => {
    if (session === null) throw new Error("session not rendered");
    return session;
  };
  const c = (): CursorApi => {
    if (cursor === null) throw new Error("session not rendered");
    return cursor;
  };
  return {
    session: s,
    beat: () => c().getBeat(),
    position: () => c().getPosition(),
    drive: (d: TransportDriver) => {
      let off: () => void = () => {};
      act(() => {
        off = s().registerTransportDriver(d);
      });
      return () => act(() => off());
    },
  };
}

/** The running timeline's path id (throws when nothing sounds). */
function generation(s: ReturnType<typeof renderSession>): number {
  const state = s.session().timeline.get();
  if (state.kind !== "running") throw new Error("timeline idle");
  return state.generation;
}

/** The beat the running timeline sounds at the wall clock's now. */
function timelineBeat(s: ReturnType<typeof renderSession>): number {
  const state = s.session().timeline.get();
  if (state.kind !== "running") throw new Error("timeline idle");
  return state.timeline.positionAt(performance.now() / 1000).beat;
}

describe("the playback timeline", () => {
  /** A clock the test moves by hand. */
  function manualClock(s: ReturnType<typeof renderSession>) {
    const clock = { t: 0 };
    act(() => {
      s.session().registerClock({
        now: () => clock.t,
        drawNow: () => clock.t,
        latency: () => 0,
      });
    });
    return clock;
  }

  it("re-times a tempo change from the change instant, not from the last frame", () => {
    const s = renderSession(song(16));
    const clock = manualClock(s);
    act(() => s.session().seekTo(0));
    act(() => s.session().play());
    clock.t = 1;
    frame();
    expect(s.beat()).toBeCloseTo(2, 9);
    // 10 ms after that frame (beat 2.02), slow to half speed: 60 bpm.
    clock.t = 1.01;
    act(() => s.session().setTempoScale(0.5));
    clock.t = 1.5;
    frame();
    // 2.02 + 0.49 s at a beat a second. Re-anchoring on the frame's beat (2)
    // lost the 10 ms: 2.49, and the cursor fell behind the sound.
    expect(s.beat()).toBeCloseTo(2.51, 9);
  });

  it("keeps the cursor on the music through a loop and a long speed drag", () => {
    const s = renderSession(song(16));
    const clock = manualClock(s);
    act(() => s.session().setLoop({ start: 0, end: 4, enabled: true }));
    act(() => s.session().seekTo(0));
    act(() => s.session().play());
    let walked = 0; // beats walked, integrated by hand
    let bpm = 120;
    for (let i = 0; i < 400; i++) {
      // A frame, then a tempo change a few ms after it.
      const toFrame = 0.004 + ((i * 7919) % 11) / 1000;
      clock.t += toFrame;
      walked += (toFrame * bpm) / 60;
      frame();
      const toChange = 0.002 + ((i * 31) % 9) / 1000;
      clock.t += toChange;
      walked += (toChange * bpm) / 60;
      const scale = 0.25 + ((i * 13) % 20) / 10;
      bpm = 120 * scale;
      act(() => s.session().setTempoScale(scale));
    }
    frame();
    expect(walked).toBeGreaterThan(8); // it wrapped
    expect(s.beat()).toBeCloseTo(walked % 4, 6);
  });
});

describe("registerClock", () => {
  it("unregistering the active clock restores the previous one, not the wall clock", () => {
    const s = renderSession(song(16));
    act(() => {
      s.session().registerCountIn(() => 4);
      s.session().registerClock({
        now: () => 10,
        drawNow: () => 10,
        latency: () => 0,
      });
    });
    let offB: () => void = () => {};
    act(() => {
      offB = s
        .session()
        .registerClock({ now: () => 20, drawNow: () => 20, latency: () => 0 });
    });
    act(() => offB());
    act(() => s.session().playWithCountIn());
    expect(s.session().countIn?.startedAtClockSec).toBe(10);
  });
});

describe("a transport driver", () => {
  it("is sought to the cursor when it registers, and follows play / stop / seek", () => {
    const s = renderSession(song(16));
    act(() => s.session().seekTo(4));
    const d = new FakeDriver();
    s.drive(d);
    expect(s.session().driven).toBe(true);
    // Beat 4 at 120 bpm = media 2 s.
    expect(d.seeks.at(-1)).toBe(2);

    act(() => s.session().play());
    expect(d.calls.at(-1)).toBe("play");
    act(() => s.session().seekTo(8));
    expect(d.seeks.at(-1)).toBe(4);
    act(() => s.session().stop());
    expect(d.calls.at(-1)).toBe("pause");
  });

  it("drives the cursor from its position, freezing it while stalled", () => {
    const s = renderSession(song(16));
    const d = new FakeDriver();
    s.drive(d);
    act(() => s.session().play());
    d.media = 3;
    d.emit({ kind: "advancing" });
    frame();
    expect(s.beat()).toBe(6);

    const before = generation(s);
    d.emit({ kind: "stalled" });
    d.media = 5;
    frame();
    expect(s.beat()).toBe(6);
    // Nothing sounds while the medium does not advance.
    expect(s.session().timeline.get().kind).toBe("idle");

    d.emit({ kind: "advancing" });
    frame();
    expect(s.beat()).toBe(10);
    // The music starts again where the medium resumed.
    expect(generation(s)).toBeGreaterThan(before);
    expect(timelineBeat(s)).toBeCloseTo(10, 1);
    expect(s.session().isPlaying).toBe(true);
  });

  it("stops the transport on an external pause, and never lets the medium start it", () => {
    const s = renderSession(song(16));
    const d = new FakeDriver();
    s.drive(d);
    act(() => s.session().play());
    d.emit({ kind: "advancing" });
    d.emit({ kind: "paused" });
    expect(s.session().isPlaying).toBe(false);

    d.calls = [];
    d.emit({ kind: "advancing" });
    expect(s.session().isPlaying).toBe(false);
    expect(d.calls).toEqual(["pause"]);
  });

  it("wraps an A–B loop by seeking the medium back to A, once", () => {
    const s = renderSession(song(16));
    const d = new FakeDriver();
    s.drive(d);
    act(() => s.session().setLoop({ start: 4, end: 8, enabled: true }));
    act(() => s.session().play());
    d.emit({ kind: "advancing" });
    frame();
    const before = generation(s);
    d.media = 4.1; // beat 8.2, past B
    frame();
    expect(d.seeks.at(-1)).toBe(2); // A = beat 4 = 2 s
    expect(s.beat()).toBe(4);
    // The music restarts at A with the medium.
    expect(generation(s)).toBe(before + 1);
    expect(timelineBeat(s)).toBeCloseTo(4, 1);

    // The medium has not landed yet: no second wrap.
    const seeks = d.seeks.length;
    d.media = 4.15;
    frame();
    expect(d.seeks.length).toBe(seeks);
    d.media = 2.5;
    frame();
    expect(s.beat()).toBe(5);
  });

  it("adopts the rate the medium took as the tempo, and 0 pauses without asking it", async () => {
    const s = renderSession(song(16));
    const d = new FakeDriver();
    s.drive(d);
    await act(async () => s.session().setTempoScale(1.1));
    expect(s.session().tempoScale).toBe(1);
    await act(async () => s.session().setTempoScale(1.2));
    expect(s.session().tempoScale).toBe(1.25);

    act(() => s.session().play());
    d.calls = [];
    await act(async () => s.session().setTempoScale(0));
    expect(s.session().tempoScale).toBe(0);
    expect(s.session().isPlaying).toBe(false);
    expect(d.calls).toEqual(["pause"]);
  });

  it("plays without a count-in, and seeks the medium to a cursor a scrub moved", () => {
    const s = renderSession(song(16));
    act(() => {
      s.session().registerCountIn(() => 4);
    });
    const d = new FakeDriver();
    s.drive(d);
    act(() => s.session().seekTo(2));
    // A scrub steps the cursor on the wall clock, without telling the medium.
    vi.spyOn(performance, "now").mockReturnValue(0);
    act(() => s.session().startScrub(1));
    vi.spyOn(performance, "now").mockReturnValue(1000);
    frame();
    act(() => s.session().endScrub());
    expect(s.beat()).toBeGreaterThan(2);
    act(() => s.session().playWithCountIn());
    expect(s.session().countIn).toBeNull();
    expect(s.session().isPlaying).toBe(true);
    // The medium was brought to the cursor on play.
    expect(d.seeks.at(-1)).toBe(s.beat() / 2);
  });

  it("a medium tearing down after it unregistered does not stop the transport", () => {
    const s = renderSession(song(16));
    const d = new FakeDriver();
    const off = s.drive(d);
    act(() => s.session().play());
    d.media = 1;
    d.emit({ kind: "advancing" });
    frame();
    // Its element unmounts: the unregister runs first, then — in the same
    // commit, before the session re-renders — the dying player reports it
    // stopped. That is the medium going away, not a pause.
    act(() => {
      off();
      d.report({ kind: "paused" });
    });
    expect(s.session().isPlaying).toBe(true);
    expect(s.session().driven).toBe(false);
  });

  it("unregistering falls back to the previous driver, then to the clock, playing on", () => {
    const s = renderSession(song(16));
    const a = new FakeDriver();
    const b = new FakeDriver();
    const offA = s.drive(a);
    const offB = s.drive(b);
    act(() => s.session().play());
    b.media = 2;
    b.emit({ kind: "advancing" });
    frame();
    expect(s.beat()).toBe(4);
    offB();
    expect(s.session().driven).toBe(true);
    // A is brought to where the transport is.
    expect(a.seeks.at(-1)).toBe(2);
    expect(s.session().isPlaying).toBe(true);
    offA();
    expect(s.session().driven).toBe(false);
    expect(s.session().timeline.get().kind).toBe("running");
    expect(s.session().isPlaying).toBe(true);
  });
});

describe("an A–B loop's rest", () => {
  /** A session on a clock the test sets, looping [4, 8) with the rest on. */
  function looping() {
    const s = renderSession(song(16));
    const clock = { t: 0 };
    act(() => {
      s.session().registerClock({
        now: () => clock.t,
        drawNow: () => clock.t,
        latency: () => 0,
      });
      s.session().setLoopOptions({ rest: true, ahead: false });
      s.session().setLoop({ start: 4, end: 8, enabled: true });
      s.session().seekTo(4);
    });
    act(() => s.session().play());
    // The play itself anchors; run one frame to start the tick.
    frame();
    return {
      s,
      at: (t: number) => {
        clock.t = t;
        frame();
      },
    };
  }

  it("is one bar at A's meter, as the session's loop cycle", () => {
    const { s } = looping();
    expect(s.session().loopCycle).toEqual({ start: 4, end: 8, rest: 4 });
  });

  it("parks the cursor on A with the rest counting down, then plays the repeat", () => {
    const { s, at } = looping();
    at(1); // beat 6, first pass
    expect(s.position()).toEqual({ beat: 6, rest: 0, repeat: false });
    at(2); // B: the rest begins — a whole bar (2 s at 120 bpm) to go
    expect(s.position()).toEqual({ beat: 4, rest: 4, repeat: true });
    at(3);
    expect(s.position()).toEqual({ beat: 4, rest: 2, repeat: true });
    at(4.5); // the repeat's body: 0.5 s past A
    expect(s.position()).toEqual({ beat: 5, rest: 0, repeat: true });
  });

  it("resumes a pause inside the rest with the rest's remainder", () => {
    const { s, at } = looping();
    at(3); // two beats of rest to go
    act(() => s.session().stop());
    act(() => s.session().play());
    frame();
    expect(s.position()).toEqual({ beat: 4, rest: 2, repeat: true });
    at(3.5);
    expect(s.position()).toEqual({ beat: 4, rest: 1, repeat: true });
  });

  it("is not applied while a medium drives (its wrap stays a seek to A)", () => {
    const s = renderSession(song(16));
    act(() => {
      s.session().setLoopOptions({ rest: true, ahead: false });
      s.session().setLoop({ start: 4, end: 8, enabled: true });
    });
    expect(s.session().loopCycle?.rest).toBe(4);
    s.drive(new FakeDriver());
    expect(s.session().loopCycle).toEqual({ start: 4, end: 8, rest: 0 });
  });
});

describe("the output latency", () => {
  /** 0.2 s from rendering to hearing: 0.4 beat at 120 bpm. */
  const LATENCY = 0.2;

  /** A session on a clock the test sets, whose sound is heard LATENCY late. */
  function latent(score: Score = song(16)) {
    const s = renderSession(score);
    const clock = { t: 0 };
    act(() => {
      s.session().registerClock({
        now: () => clock.t,
        drawNow: () => clock.t,
        latency: () => LATENCY,
      });
    });
    return {
      s,
      clock,
      at: (t: number) => {
        clock.t = t;
        frame();
      },
    };
  }

  it("draws the cursor where the music is heard, holding at the start until it is", () => {
    const { s, at } = latent();
    act(() => s.session().seekTo(4));
    act(() => s.session().play());
    at(0.1); // nothing heard yet
    expect(s.beat()).toBe(4);
    at(1.2); // heard: 1.0 s of music
    expect(s.beat()).toBeCloseTo(6, 9);
    expect(s.session().heardNow()).toBeCloseTo(1, 9);
  });

  it("holds a seek's target until its first sound is heard", () => {
    const { s, at } = latent();
    act(() => s.session().seekTo(0));
    act(() => s.session().play());
    at(1.2);
    act(() => s.session().seekTo(10));
    at(1.3); // the old music is still heard, but a seek shows its target
    expect(s.beat()).toBe(10);
    at(1.9); // heard 0.5 s past the seek
    expect(s.beat()).toBeCloseTo(11, 9);
  });

  it("keeps the cursor continuous through a loop edit from where the music is", () => {
    const { s, clock, at } = latent();
    act(() => s.session().seekTo(0));
    act(() => s.session().play());
    clock.t = 1; // rendering beat 2, heard beat 1.6
    act(() => s.session().setLoop({ start: 8, end: 12, enabled: true }));
    at(1.1); // still hearing the path before the edit
    expect(s.beat()).toBeCloseTo(1.8, 9);
    at(1.3); // the edited path, heard from where it took over
    expect(s.beat()).toBeCloseTo(2.2, 9);
  });

  it("follows the old tempo until a tempo change is heard", () => {
    const { s, clock, at } = latent();
    act(() => s.session().seekTo(0));
    act(() => s.session().play());
    clock.t = 1; // rendering beat 2
    act(() => s.session().setTempoScale(0.5)); // 60 bpm from beat 2 on
    at(1.1); // heard 0.9 s: still at 120 bpm
    expect(s.beat()).toBeCloseTo(1.8, 9);
    at(1.5); // heard 1.3 s: 0.3 s past the change at a beat a second
    expect(s.beat()).toBeCloseTo(2.3, 9);
  });

  it("stops at the song's end when its last sound is heard, not rendered", () => {
    const { s, at } = latent(song(4));
    act(() => s.session().seekTo(0));
    act(() => s.session().play());
    at(2.1); // the end (beat 4, 2 s) is rendered, not heard yet
    expect(s.session().isPlaying).toBe(true);
    at(2.3);
    expect(s.session().isPlaying).toBe(false);
    expect(s.beat()).toBe(4);
  });

  it("times the synth so it is heard with a driving medium, not rendered with it", () => {
    const { s, at } = latent();
    const d = new FakeDriver();
    s.drive(d);
    act(() => s.session().play());
    d.media = 2; // beat 4, heard now
    d.emit({ kind: "advancing" });
    at(5);
    expect(s.beat()).toBe(4);
    const state = s.session().timeline.get();
    if (state.kind !== "running") throw new Error("timeline idle");
    // Beat 4 is rendered one latency before now, so it is heard now.
    expect(state.timeline.positionAt(5 - LATENCY).beat).toBeCloseTo(4, 9);
  });
});
