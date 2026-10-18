import { describe, expect, it } from "bun:test";
import {
  emptyScore,
  type Annotation,
  type Note,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { patternFromPreset } from "@plugins/apps/plugins/sonata/plugins/rhythm/core";
import {
  CHORD_BASS_TRACK,
  CHORD_TRACK,
  grooveCycles,
  hasOwnNotes,
  reVoiceChords,
  type ReVoiceGroove,
} from "./revoice";

/**
 * `reVoiceChords` selection tests. The default pass voices AUTHORED chords only
 * (a symbol source's annotations); `include: "all"` — the chord-mode pass — also
 * voices analyzer-DERIVED chords, which a MIDI song has instead of authored ones.
 * The voicing math itself is covered by `voicing.test.ts`; here we check which
 * annotations reach it, that the original tracks survive, that a re-run replaces
 * rather than duplicates, and that voiced annotations point at the new notes.
 */

/** One root-position block triad per bar, right hand only. */
const CFG: ReVoiceGroove = {
  hands: {
    chord: patternFromPreset("basic-1"),
    bass: patternFromPreset("basic-1"),
  },
  chordFigurationId: "block",
  bassFigurationId: "root",
  chordVoicing: {
    enabled: true,
    octave: 4,
    voiceLead: false,
    doubleOctave: false,
  },
  bassVoicing: {
    enabled: false,
    octave: 2,
    voiceLead: false,
    doubleOctave: false,
  },
  restartOnChordChange: false,
};

function chord(
  source: Annotation["source"],
  start: number,
  end: number,
  noteIds?: string[],
): Annotation {
  return {
    type: "chord",
    start,
    end,
    data: { symbol: "C", root: 0, quality: "maj" },
    source,
    ...(noteIds ? { target: { noteIds } } : {}),
  };
}

const midiNote = (id: string, start: number): Note => ({
  id,
  pitch: 60,
  start,
  duration: 1,
  velocity: 80,
  track: "t0",
});

function midiScore(annotations: Annotation[]): Score {
  return {
    ...emptyScore(),
    tracks: [{ id: "t0", name: "Piano" }],
    notes: [midiNote("m0", 0), midiNote("m1", 4)],
    annotations,
  };
}

const chordTrackNotes = (s: Score) =>
  s.notes.filter(
    (n) => n.track === CHORD_TRACK || n.track === CHORD_BASS_TRACK,
  );
const originalNotes = (s: Score) => s.notes.filter((n) => n.track === "t0");

describe("reVoiceChords — selection", () => {
  it("ignores derived chords by default (score returned unchanged)", () => {
    const score = midiScore([chord("derived", 0, 4, ["m0"])]);
    expect(reVoiceChords(score, CFG)).toBe(score);
  });

  it("include:'all' voices derived chords onto the chord tracks, keeping the originals", () => {
    const score = midiScore([
      chord("derived", 0, 4, ["m0"]),
      chord("derived", 4, 8, ["m1"]),
    ]);
    const out = reVoiceChords(score, CFG, { include: "all" });

    expect(originalNotes(out)).toEqual(originalNotes(score));
    // Two C-major block triads, one per chord, all on the chord track.
    const voiced = chordTrackNotes(out);
    expect(voiced).toHaveLength(6);
    expect(voiced.every((n) => n.track === CHORD_TRACK)).toBe(true);
    expect(out.tracks.map((t) => t.id)).toEqual([
      "t0",
      CHORD_TRACK,
      CHORD_BASS_TRACK,
    ]);
  });

  it("a second include:'all' pass replaces the chord-track notes, never duplicates them", () => {
    const score = midiScore([chord("derived", 0, 4)]);
    const once = reVoiceChords(score, CFG, { include: "all" });
    const twice = reVoiceChords(once, CFG, { include: "all" });
    expect(chordTrackNotes(twice)).toEqual(chordTrackNotes(once));
    expect(twice.notes).toHaveLength(once.notes.length);
  });

  it("re-targets every voiced annotation at the notes generated for it", () => {
    const score = midiScore([
      chord("derived", 0, 4, ["m0"]),
      chord("derived", 4, 8, ["m1"]),
    ]);
    const out = reVoiceChords(score, CFG, { include: "all" });
    const voicedIds = new Set(chordTrackNotes(out).map((n) => n.id));

    for (const a of out.annotations) {
      const ids = a.target?.noteIds ?? [];
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => voicedIds.has(id))).toBe(true);
      // Each chord owns exactly the notes that start inside its span.
      const notes = chordTrackNotes(out).filter((n) => ids.includes(n.id));
      expect(notes.every((n) => n.start >= a.start && n.start < a.end)).toBe(
        true,
      );
    }
    // No annotation still points at the original MIDI notes.
    expect(out.annotations.some((a) => a.target?.noteIds?.includes("m0"))).toBe(
      false,
    );
  });

  it("the authored-only pass leaves derived annotations' targets untouched", () => {
    const derived = chord("derived", 4, 8, ["m1"]);
    const score = midiScore([chord("authored", 0, 4), derived]);
    const out = reVoiceChords(score, CFG);
    expect(out.annotations.find((a) => a.source === "derived")).toBe(derived);
    expect(chordTrackNotes(out)).toHaveLength(3);
  });
});

describe("reVoiceChords — restart on chord change", () => {
  // One bar of 4/4 (beats 0–4) whose chord changes on beat 2.
  const score = midiScore([chord("authored", 0, 2), chord("authored", 2, 4)]);
  const chordOnsets = (s: Score) => [
    ...new Set(
      s.notes.filter((n) => n.track === CHORD_TRACK).map((n) => n.start),
    ),
  ];

  it("bar-anchored: a one-onset necklace skips the mid-bar chord", () => {
    expect(chordOnsets(reVoiceChords(score, CFG))).toEqual([0]);
  });

  it("restarted: the mid-bar chord change strikes its own chord", () => {
    const out = reVoiceChords(score, { ...CFG, restartOnChordChange: true });
    expect(chordOnsets(out)).toEqual([0, 2]);
  });

  it("a restarted cycle keeps the bar's pulse and is cut at the bar line", () => {
    const cycles = grooveCycles(score, { restartOnChordChange: true });
    expect(cycles.slice(0, 2)).toEqual([
      { start: 0, end: 2, span: 4 },
      { start: 2, end: 4, span: 4 },
    ]);
  });
});

describe("hasOwnNotes", () => {
  it("is false for a chord-only score, even once its chords are voiced", () => {
    const chordOnly: Score = {
      ...emptyScore(),
      annotations: [chord("authored", 0, 4)],
    };
    expect(hasOwnNotes(chordOnly)).toBe(false);
    expect(hasOwnNotes(reVoiceChords(chordOnly, CFG))).toBe(false);
  });

  it("is true for a score with notes off the chord tracks", () => {
    expect(hasOwnNotes(midiScore([chord("authored", 0, 4)]))).toBe(true);
  });
});
