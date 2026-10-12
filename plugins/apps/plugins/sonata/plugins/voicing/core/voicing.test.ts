import { describe, expect, it } from "bun:test";
import { voiceChords, type ChordEvent, type VoicingOptions } from "./voicing";
import { findFiguration } from "./figuration";

/**
 * Voicing emission tests. The rhythm axis is orthogonal: with `opts.rhythm`
 * ABSENT the engine must emit exactly today's block notes (the no-regression
 * property), and with it PRESENT chords are struck on the bar-anchored onset
 * necklace passed in as absolute beats.
 *
 * Chord pitches are `chordPitches(data, octave)` = `[base, ...intervals]` where
 * `base = 12·(octave+1) + root` and a "maj" triad is `[4, 7]`. So at octave 4:
 *   C maj (root 0) → [60, 64, 67];  G maj (root 7) → [67, 71, 74].
 * These are the hardcoded expectations derived from the pitch model, not from
 * re-running the code under test.
 */

const OPTS: VoicingOptions = {
  octave: 4,
  track: "chords",
  idPrefix: "chord",
};

const cMaj = (start: number, end: number): ChordEvent => ({
  data: { symbol: "C", root: 0, quality: "maj" },
  start,
  end,
});
const gMaj = (start: number, end: number): ChordEvent => ({
  data: { symbol: "G", root: 7, quality: "maj" },
  start,
  end,
});

describe("block-full — no rhythm regression", () => {
  it("emits identical block notes to today's code on a 2-chord list", () => {
    const events = [cMaj(0, 4), gMaj(4, 8)];
    const notes = voiceChords(events, OPTS);

    // Hardcoded expectation from reading today's block-full: one note per tone
    // per event, id `${idPrefix}-${i}-${k}`, start = ev.start, duration =
    // ev.end - ev.start, velocity 80, track "chords", voice undefined, no bass.
    expect(notes).toEqual([
      {
        id: "chord-0-0",
        pitch: 60,
        start: 0,
        duration: 4,
        velocity: 80,
        track: "chords",
        voice: undefined,
      },
      {
        id: "chord-0-1",
        pitch: 64,
        start: 0,
        duration: 4,
        velocity: 80,
        track: "chords",
        voice: undefined,
      },
      {
        id: "chord-0-2",
        pitch: 67,
        start: 0,
        duration: 4,
        velocity: 80,
        track: "chords",
        voice: undefined,
      },
      {
        id: "chord-1-0",
        pitch: 67,
        start: 4,
        duration: 4,
        velocity: 80,
        track: "chords",
        voice: undefined,
      },
      {
        id: "chord-1-1",
        pitch: 71,
        start: 4,
        duration: 4,
        velocity: 80,
        track: "chords",
        voice: undefined,
      },
      {
        id: "chord-1-2",
        pitch: 74,
        start: 4,
        duration: 4,
        velocity: 80,
        track: "chords",
        voice: undefined,
      },
    ]);
  });
});

describe("block-full — bar-anchored rhythm", () => {
  it("strikes each chord onset in the bar (onsets [0,2] over [0,4))", () => {
    const events = [cMaj(0, 4)];
    // A 4-subdivision bar over [0,4): onsets 0 and 2 resolve to beats 0 and 2.
    const notes = voiceChords(events, {
      ...OPTS,
      rhythm: { bass: [], chord: [0, 2] },
    });

    // Two strikes (beats 0, 2), each the full triad, duration 2 (clipped to the
    // next onset). ids onset-indexed `-c${i}-${k}`; voice 1 (bass present).
    expect(notes).toEqual([
      {
        id: "chord-c0-0",
        pitch: 60,
        start: 0,
        duration: 2,
        velocity: 80,
        track: "chords",
        voice: 1,
      },
      {
        id: "chord-c0-1",
        pitch: 64,
        start: 0,
        duration: 2,
        velocity: 80,
        track: "chords",
        voice: 1,
      },
      {
        id: "chord-c0-2",
        pitch: 67,
        start: 0,
        duration: 2,
        velocity: 80,
        track: "chords",
        voice: 1,
      },
      {
        id: "chord-c1-0",
        pitch: 60,
        start: 2,
        duration: 2,
        velocity: 80,
        track: "chords",
        voice: 1,
      },
      {
        id: "chord-c1-1",
        pitch: 64,
        start: 2,
        duration: 2,
        velocity: 80,
        track: "chords",
        voice: 1,
      },
      {
        id: "chord-c1-2",
        pitch: 67,
        start: 2,
        duration: 2,
        velocity: 80,
        track: "chords",
        voice: 1,
      },
    ]);
  });

  it("a half-bar chord gets only the onsets falling in its half", () => {
    // Chord occupies only [2,4); the bar-anchored onsets are still 0 and 2.
    const events = [cMaj(2, 4)];
    const notes = voiceChords(events, {
      ...OPTS,
      rhythm: { bass: [], chord: [0, 2] },
    });

    // Onset at beat 0 is silence (no chord in force) and skipped; only beat 2
    // strikes — and it keeps onset index 1, proving ids are onset-indexed.
    expect(notes).toEqual([
      {
        id: "chord-c1-0",
        pitch: 60,
        start: 2,
        duration: 2,
        velocity: 80,
        track: "chords",
        voice: 1,
      },
      {
        id: "chord-c1-1",
        pitch: 64,
        start: 2,
        duration: 2,
        velocity: 80,
        track: "chords",
        voice: 1,
      },
      {
        id: "chord-c1-2",
        pitch: 67,
        start: 2,
        duration: 2,
        velocity: 80,
        track: "chords",
        voice: 1,
      },
    ]);
  });
});

describe("bass decoupling", () => {
  it("emits a bass note when rhythm is set even with voiceLead false", () => {
    const events = [cMaj(0, 4)];
    const notes = voiceChords(events, {
      ...OPTS,
      voiceLead: false,
      rhythm: { bass: [0], chord: [] },
    });

    // No chord hand; one bass note at the low root (lowBassPitch(0) = 36),
    // voice 0, id `-b${onset}-${k}` (the `-${k}` since a bass figuration can
    // strike a dyad), duration spanning to the chord end.
    expect(notes).toEqual([
      {
        id: "chord-b0-0",
        pitch: 36,
        start: 0,
        duration: 4,
        velocity: 80,
        track: "chords",
        voice: 0,
      },
    ]);
  });
});

describe("per-hand figuration", () => {
  it("plays a different figuration on each hand — pitches differ accordingly", () => {
    // One C-maj chord over a full bar. Bass hand = octave-bass ([D1, D8] →
    // 36, 48), chord hand = block ([60, 64, 67] struck whole). Onsets [0, 2] on
    // both hands, so bass alternates root/octave while chord strikes the triad.
    const events = [cMaj(0, 4)];
    const notes = voiceChords(events, {
      ...OPTS,
      bassTrack: "chords-bass",
      rhythm: { bass: [0, 2], chord: [0, 2] },
      figuration: {
        bass: findFiguration("octave-bass"),
        chord: findFiguration("block"),
      },
    });

    const bass = notes
      .filter((n) => n.voice === 0)
      .sort((a, b) => a.start - b.start);
    const chord = notes
      .filter((n) => n.voice === 1)
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch);

    // Bass: octave-bass — position 0 (beat 0) → root 36; position 1 (beat 2) →
    // octave root 48. Distinct low-register pitches, on the bass track.
    expect(bass.map((n) => n.pitch)).toEqual([36, 48]);
    for (const n of bass) expect(n.track).toBe("chords-bass");
    expect(bass.map((n) => n.id)).toEqual(["chord-b0-0", "chord-b1-0"]);

    // Chord: block — the whole triad at each onset, chord register, chord track.
    expect(chord.map((n) => n.pitch)).toEqual([60, 64, 67, 60, 64, 67]);
    for (const n of chord) expect(n.track).toBe("chords");

    // The two hands genuinely differ: no bass pitch appears in the chord hand.
    for (const b of bass)
      expect(chord.some((c) => c.pitch === b.pitch)).toBe(false);
  });
});

describe("bassTrack split", () => {
  it("routes bass to bassTrack while chord tones stay on track (block path)", () => {
    const events = [cMaj(0, 4)];
    const notes = voiceChords(events, {
      ...OPTS,
      bassTrack: "chords-bass",
      voiceLead: true, // wantsBass → a bass note is emitted in the block path
    });

    const bass = notes.filter((n) => n.voice === 0);
    const upper = notes.filter((n) => n.voice === 1);
    expect(bass.length).toBe(1);
    expect(bass[0]!.track).toBe("chords-bass");
    expect(upper.length).toBeGreaterThan(0);
    for (const n of upper) expect(n.track).toBe("chords");
  });

  it("routes bass to bassTrack while chord tones stay on track (rhythm path)", () => {
    const events = [cMaj(0, 4)];
    const notes = voiceChords(events, {
      ...OPTS,
      bassTrack: "chords-bass",
      rhythm: { bass: [0], chord: [0] },
    });

    const bass = notes.filter((n) => n.voice === 0);
    const upper = notes.filter((n) => n.voice === 1);
    expect(bass.length).toBe(1);
    expect(bass[0]!.track).toBe("chords-bass");
    expect(upper.length).toBeGreaterThan(0);
    for (const n of upper) expect(n.track).toBe("chords");
  });
});

describe("duration clipping", () => {
  it("a note never rings across a chord change", () => {
    // C over [0,4), G over [4,8); a chord onset at beat 3 with the next onset at
    // beat 5. Without clipping the note would ring 3→5 (duration 2); it must be
    // clipped to the C chord's end at beat 4 (duration 1).
    const events = [cMaj(0, 4), gMaj(4, 8)];
    const notes = voiceChords(events, {
      ...OPTS,
      rhythm: { bass: [], chord: [3, 5] },
    });

    const at3 = notes.filter((n) => n.start === 3);
    const at5 = notes.filter((n) => n.start === 5);
    expect(at3.length).toBeGreaterThan(0);
    for (const n of at3) expect(n.duration).toBe(1); // clipped at the chord change
    for (const n of at5) expect(n.duration).toBe(3); // 5 → G end at 8
    // The beat-3 note sounds the C triad; the beat-5 note the G triad.
    expect(at3.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([60, 64, 67]);
    expect(at5.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([67, 71, 74]);
  });
});

describe("per-hand voicing (opts.hands)", () => {
  const on = { enabled: true, voiceLead: false, doubleOctave: false };
  const hands = {
    chord: { ...on, octave: 4 },
    bass: { ...on, octave: 2 },
  };
  const fig = {
    bass: findFiguration("root"),
    chord: findFiguration("block"),
  };

  it("places each hand at its own octave", () => {
    const notes = voiceChords([cMaj(0, 4)], {
      ...OPTS,
      rhythm: { bass: [0], chord: [0] },
      figuration: fig,
      hands: { chord: { ...on, octave: 5 }, bass: { ...on, octave: 1 } },
    });
    // C5 triad = [72, 76, 79]; bass root C1 = 24.
    expect(notes.filter((n) => n.voice !== 0).map((n) => n.pitch)).toEqual([
      72, 76, 79,
    ]);
    expect(notes.filter((n) => n.voice === 0).map((n) => n.pitch)).toEqual([
      24,
    ]);
  });

  it("a hand that is off strikes nothing", () => {
    const notes = voiceChords([cMaj(0, 4)], {
      ...OPTS,
      rhythm: { bass: [0], chord: [0] },
      figuration: fig,
      hands: { ...hands, chord: { ...hands.chord, enabled: false } },
    });
    expect(notes.map((n) => n.pitch)).toEqual([36]);
  });

  it("octave doubling adds each struck pitch an octave above, on a distinct id", () => {
    const notes = voiceChords([cMaj(0, 4)], {
      ...OPTS,
      rhythm: { bass: [0], chord: [] },
      figuration: fig,
      hands: {
        ...hands,
        bass: { ...hands.bass, octave: 1, doubleOctave: true },
      },
    });
    // C1 + C2.
    expect(notes.map((n) => [n.id, n.pitch])).toEqual([
      ["chord-b0-0", 24],
      ["chord-b0-0o", 36],
    ]);
  });

  it("bass voice-leading moves the root to the nearest octave", () => {
    // C2 (36) then B: placed at B2 (47), but B1 (35) is nearer the C2 before it.
    const bMaj: ChordEvent = {
      data: { symbol: "B", root: 11, quality: "maj" },
      start: 4,
      end: 8,
    };
    const play = (voiceLead: boolean) =>
      voiceChords([cMaj(0, 4), bMaj], {
        ...OPTS,
        rhythm: { bass: [0, 4], chord: [] },
        figuration: fig,
        hands: { ...hands, bass: { ...hands.bass, voiceLead } },
      }).map((n) => n.pitch);
    expect(play(false)).toEqual([36, 47]);
    expect(play(true)).toEqual([36, 35]);
  });
});
