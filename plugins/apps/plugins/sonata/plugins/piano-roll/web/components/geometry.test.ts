/**
 * Tests for the pure authored-space note geometry (`authoredSecondsOf` /
 * `buildNoteVisuals`). The load-bearing property is AUTHORED-SPACE INVARIANCE:
 * the incoming score's tempo map has `tempoScale` folded in (seconds =
 * authoredSeconds / tempoScale), and `authoredSecondsOf` must cancel that fold
 * exactly — so the visuals a renderer uploads to the GPU never change when the
 * user slows or speeds playback.
 */

import { expect, test } from "bun:test";
import {
  buildTempoIndex,
  emptyScore,
  songAxis,
  makeKeySpeller,
  scaleTempo,
  type Note,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { PitchLayoutId } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { pitchGeometry } from "@plugins/apps/plugins/sonata/plugins/pitch-layout/core";
import {
  authoredSecondsOf,
  buildNoteVisuals,
  buildProjection,
  KEYBOARD_HIGH,
  KEYBOARD_LOW,
} from "./geometry";

/**
 * Every keyboard layout, so the roll's X contract is proven on all of them. A
 * `Record` over the closed id set: a new layout is a tsc error here until it is
 * listed.
 */
const LAYOUTS = Object.keys({
  piano: true,
  janko: true,
} satisfies Record<PitchLayoutId, true>) as PitchLayoutId[];
const planeFor = (id: PitchLayoutId) =>
  pitchGeometry(id, KEYBOARD_LOW, KEYBOARD_HIGH);
const PIANO = planeFor("piano");

// --- fixtures ----------------------------------------------------------------

let nid = 0;
const note = (
  pitch: number,
  start: number,
  duration: number,
  opts?: { velocity?: number; track?: string },
): Note => ({
  id: `n${nid++}`,
  pitch,
  start,
  duration,
  velocity: opts?.velocity ?? 90,
  track: opts?.track ?? "t1",
});

/** A tiny authored score: two tempo segments so the fold is non-trivial. */
const makeScore = (notes: Note[]): Score => ({
  ...emptyScore(),
  tracks: [{ id: "t1" }, { id: "t2" }],
  tempoMap: [
    { beat: 0, bpm: 120 },
    { beat: 4, bpm: 60 },
  ],
  notes,
});

const speller = makeKeySpeller();

const build = (
  score: Score,
  tempoScale = 1,
  over?: Partial<Parameters<typeof buildNoteVisuals>[0]>,
) =>
  buildNoteVisuals({
    score,
    plane: PIANO,
    hiddenIds: new Set<string>(),
    colorMap: new Map<string, string>(),
    accidentalColor: (base) => base,
    speller,
    tempoScale,
    ...over,
  });

// --- authored-space invariance ------------------------------------------------

test("authoredSecondsOf cancels the tempoScale fold exactly", () => {
  const authored = makeScore([]);
  for (const tempoScale of [0.5, 1, 1.25, 2]) {
    // `scaleTempo` is exactly the fold the shell applies before handing the
    // score to displays: bpm × tempoScale ⇒ seconds = authored / tempoScale.
    const tempo = buildTempoIndex(scaleTempo(authored, tempoScale));
    const authoredTempo = buildTempoIndex(authored);
    for (const beat of [0, 1, 3.5, 4, 7, 12]) {
      expect(authoredSecondsOf(tempo, tempoScale, beat)).toBeCloseTo(
        authoredTempo.beatToSeconds(beat),
        10,
      );
    }
  }
});

test("note visuals are identical across tempoScale (given correctly-scaled maps)", () => {
  const notes = [note(60, 0, 1), note(61, 3, 2), note(72, 6, 0.5)];
  const authored = makeScore(notes);
  const at1 = build(scaleTempo(authored, 1), 1);
  const at05 = build(scaleTempo(authored, 0.5), 0.5);
  const at2 = build(scaleTempo(authored, 2), 2);
  for (const other of [at05, at2]) {
    expect(other.length).toBe(at1.length);
    for (let i = 0; i < at1.length; i++) {
      expect(other[i]!.y0Sec).toBeCloseTo(at1[i]!.y0Sec, 10);
      expect(other[i]!.y1Sec).toBeCloseTo(at1[i]!.y1Sec, 10);
    }
  }
  // Sanity: the second tempo segment (60bpm from beat 4) actually engaged —
  // beat 6 is 2s (beats 0–4 at 120) + 2s (beats 4–6 at 60) = 4s authored.
  expect(at1[2]!.y0Sec).toBeCloseTo(4, 10);
});

// --- spread (vertical zoom) ----------------------------------------------------

test("buildProjection scales the whole Y axis by spread (and 1 is the baseline)", () => {
  const notes = [note(60, 0, 1), note(62, 3, 2)];
  const score = makeScore(notes);
  const at = (spread: number) =>
    buildProjection({
      width: 520,
      height: 400,
      plane: PIANO,
      score,
      timeline: songAxis(emptyScore()).timeline,
      tempoScale: 1,
      spread,
    });

  const base = at(1);
  const zoomed = at(2);
  // Note positions (beatToY) scale linearly with spread. (The roll always
  // offers the time-axis capability, so these closures are present.)
  for (const beat of [0, 1, 3, 5]) {
    expect(zoomed.beatToY!(beat)).toBeCloseTo(base.beatToY!(beat) * 2, 9);
  }
  // Note HEIGHTS scale too — the Synthesia "taller notes" zoom (unlike tempo,
  // which leaves heights fixed). X is untouched.
  const r1 = base.noteToRect!(notes[0]!)!;
  const r2 = zoomed.noteToRect!(notes[0]!)!;
  expect(r2.h).toBeCloseTo(r1.h * 2, 9);
  expect(r2.x).toBeCloseTo(r1.x, 9);
  expect(r2.w).toBeCloseTo(r1.w, 9);
});

test("buildProjection's yToBeat inverts beatToY across tempo changes and zoom", () => {
  const score = makeScore([note(60, 0, 1), note(62, 6, 2)]);
  const p = buildProjection({
    width: 520,
    height: 400,
    plane: PIANO,
    score: scaleTempo(score, 0.5),
    timeline: songAxis(emptyScore()).timeline,
    tempoScale: 0.5,
    spread: 1.7,
  });
  for (const beat of [0, 1.5, 4, 5.25, 8]) {
    expect(p.yToBeat!(p.beatToY!(beat))).toBeCloseTo(beat, 9);
  }
});

// --- per-note fields -----------------------------------------------------------

test("alpha maps velocity 0..127 onto 0.4..1.0", () => {
  const score = makeScore([
    note(60, 0, 1, { velocity: 0 }),
    note(60, 0, 1, { velocity: 127 }),
    note(60, 0, 1, { velocity: 64 }),
  ]);
  const [v0, v127, v64] = build(score);
  expect(v0!.alpha).toBeCloseTo(0.4, 10);
  expect(v127!.alpha).toBeCloseTo(1.0, 10);
  expect(v64!.alpha).toBeCloseTo(0.4 + (64 / 127) * 0.6, 10);
});

test("isAccidental flags accidental pitch classes", () => {
  const score = makeScore([note(60, 0, 1), note(61, 0, 1)]); // C4, C#4
  const [c, cSharp] = build(score);
  expect(c!.isAccidental).toBe(false);
  expect(cSharp!.isAccidental).toBe(true);
  expect(c!.label).toEqual({ step: "C", accidental: "" });
  expect(cSharp!.label).toEqual({ step: "C", accidental: "♯" });
});

test("xFrac/wFrac are the plane's own note columns, on every layout", () => {
  const pitches = [21, 60, 61, 108]; // A0, C4 (natural), C#4, C8
  const score = makeScore(pitches.map((p) => note(p, 0, 1)));
  for (const id of LAYOUTS) {
    const plane = planeFor(id);
    const columns = new Map(plane.columns.map((c) => [c.pitch, c]));
    const visuals = build(score, 1, { plane });
    visuals.forEach((v, i) => {
      const col = columns.get(pitches[i]!)!;
      expect(v.wFrac).toBeCloseTo(col.width, 10);
      expect(v.xFrac).toBeCloseTo(col.center - col.width / 2, 10);
    });
    // Fractions, not pixels: everything lives in 0..1.
    for (const v of visuals) {
      expect(v.xFrac).toBeGreaterThanOrEqual(0);
      expect(v.xFrac + v.wFrac).toBeLessThanOrEqual(1 + 1e-9);
    }
  }
});

test("a pitch the axis does not carry is dropped, and yields no rect", () => {
  // MIDI 8 is below A0 (21), so no layout of the roll's range carries it.
  const score = makeScore([note(8, 0, 1), note(60, 0, 1)]);
  for (const id of LAYOUTS) {
    const plane = planeFor(id);
    const visuals = build(score, 1, { plane });
    expect(visuals.map((v) => v.noteId)).toEqual([score.notes[1]!.id]);

    const projection = buildProjection({
      width: 520,
      height: 400,
      plane,
      score,
      timeline: songAxis(emptyScore()).timeline,
      tempoScale: 1,
      spread: 1,
    });
    expect(projection.pitchToX!(8)).toBeNull();
    expect(projection.noteToRect!(score.notes[0]!)).toBeNull();
    // …and a pitch it DOES carry still gets a real box.
    expect(projection.noteToRect!(score.notes[1]!)).not.toBeNull();
  }
});

test("hidden tracks are dropped entirely", () => {
  const score = makeScore([
    note(60, 0, 1, { track: "t1" }),
    note(62, 1, 1, { track: "t2" }),
    note(64, 2, 1, { track: "t1" }),
  ]);
  const visuals = build(score, 1, { hiddenIds: new Set(["t1"]) });
  expect(visuals.length).toBe(1);
  expect(visuals[0]!.trackId).toBe("t2");
});

test("colorExpr carries the track color, with var(--primary) as the uniform fallback", () => {
  const score = makeScore([
    note(60, 0, 1, { track: "t1" }),
    note(62, 0, 1, { track: "t2" }),
  ]);
  const visuals = build(score, 1, {
    colorMap: new Map([["t1", "var(--categorical-3)"]]),
  });
  expect(visuals[0]!.colorExpr).toBe("var(--categorical-3)");
  expect(visuals[1]!.colorExpr).toBe("var(--primary)");
});
