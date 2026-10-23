import {
  bars,
  makeKeySpeller,
  songKey,
  type Note,
  type PitchSpelling,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { COVER_H, COVER_W, n, svgDocument } from "./svg";

/**
 * The staff cover's palette. Fixed data, like the roll's: the cover is a cached
 * file, so it cannot read theme tokens. Night ground, chalk staff lines and
 * sage ink — the score cover of the redesign prototype (proto-1792667077-4bakda).
 */
const GROUND = "#0f1310";
const LINE = "#ffffff";
const LINE_ALPHA = 0.22;
const INK = "#7fb685";

/** Distance between two staff lines; a diatonic step is half of it. */
const GAP = 7;
const TREBLE_TOP = 44;
const BASS_TOP = 122;
const LEFT = 18;
const RIGHT = COVER_W - 14;
/** First notehead's x, after the system's opening bracket. */
const FIRST_X = 40;

/** At most this many noteheads per staff — a cover, not an engraving. */
const MAX_HEADS = 12;
/** At most this many onsets across the system, however sparse the staves. */
const MAX_ONSETS = 12;
/** A note this far outside the staff is moved an octave toward it. */
const MAX_LEDGER = 2;

const STEPS: readonly PitchSpelling["step"][] = [
  "C",
  "D",
  "E",
  "F",
  "G",
  "A",
  "B",
];

/** One staff's frame, as diatonic indices (`octave × 7 + step`). */
interface Staff {
  top: number;
  /** The bottom line's diatonic index (E4 on treble, G2 on bass). */
  bottom: number;
}
const TREBLE: Staff = { top: TREBLE_TOP, bottom: 4 * 7 + 2 };
const BASS: Staff = { top: BASS_TOP, bottom: 2 * 7 + 4 };

const staffBottomY = (s: Staff) => s.top + 4 * GAP;
const stepY = (s: Staff, d: number) =>
  staffBottomY(s) - ((d - s.bottom) * GAP) / 2;

/**
 * A schematic grand staff of the song's REAL opening: the notes of its first
 * bars, highest-pitched track on the treble staff and lowest on the bass (one
 * track split at middle C), each notehead on its diatonic step under the
 * song's key spelling, with ledger lines (at most two — a note further out is
 * drawn an octave closer), stems, accidentals for out-of-key notes and the
 * bar lines between them.
 *
 * Schematic, not engraved: onsets are evenly spaced, there are no clefs, rests
 * or beams. A real engraving (VexFlow) needs a DOM, and a cover is a string
 * rendered on the server — what has to be true is that the notes are the
 * song's. Deterministic; an empty score draws the empty grand staff.
 */
export function renderStaffCover(score: Score): string {
  const parts: string[] = [
    `<rect width="${COVER_W}" height="${COVER_H}" fill="${GROUND}"/>`,
  ];
  for (const s of [TREBLE, BASS]) {
    for (let l = 0; l < 5; l++) {
      parts.push(
        `<rect x="${LEFT}" y="${n(s.top + l * GAP - 0.35)}" width="${RIGHT - LEFT}" height="0.7" fill="${LINE}" fill-opacity="${LINE_ALPHA}"/>`,
      );
    }
  }
  // The system's opening line and bracket, joining both staves.
  const sysBottom = staffBottomY(BASS);
  parts.push(
    `<rect x="${LEFT}" y="${TREBLE_TOP}" width="0.9" height="${sysBottom - TREBLE_TOP}" fill="${LINE}" fill-opacity="${LINE_ALPHA * 2}"/>`,
    `<path d="M${LEFT - 4} ${TREBLE_TOP - 2}h3v${sysBottom - TREBLE_TOP + 4}h-3" fill="none" stroke="${LINE}" stroke-opacity="${LINE_ALPHA * 2}" stroke-width="1.6"/>`,
  );

  const split = splitStaves(score);
  const key = songKey(score)?.key;
  const speller = makeKeySpeller(key);
  const spell = (note: Note): PitchSpelling =>
    note.spelling ?? speller.spell(note.pitch);

  // Distinct onsets in order, taken while neither staff exceeds MAX_HEADS.
  const onsets = [
    ...new Set([...split.treble, ...split.bass].map((x) => x.start)),
  ]
    .sort((a, b) => a - b)
    .slice(0, MAX_ONSETS);
  const taken: number[] = [];
  let heads = { treble: 0, bass: 0 };
  for (const t of onsets) {
    const next = {
      treble: heads.treble + split.treble.filter((x) => x.start === t).length,
      bass: heads.bass + split.bass.filter((x) => x.start === t).length,
    };
    if (next.treble > MAX_HEADS || next.bass > MAX_HEADS) break;
    taken.push(t);
    heads = next;
  }

  if (taken.length > 0) {
    const step = (RIGHT - 10 - FIRST_X) / Math.max(1, taken.length - 1);
    const xOf = (i: number) =>
      taken.length === 1 ? (FIRST_X + RIGHT) / 2 : FIRST_X + i * step;

    // Bar lines midway between the onsets a bar line falls between.
    const lines = bars(score).map((b) => b.startBeat);
    for (let i = 1; i < taken.length; i++) {
      if (lines.some((b) => b > taken[i - 1]! && b <= taken[i]!)) {
        const x = (xOf(i - 1) + xOf(i)) / 2;
        parts.push(
          `<rect x="${n(x)}" y="${TREBLE_TOP}" width="0.8" height="${n(4 * GAP)}" fill="${LINE}" fill-opacity="${LINE_ALPHA * 1.6}"/>`,
          `<rect x="${n(x)}" y="${BASS_TOP}" width="0.8" height="${n(4 * GAP)}" fill="${LINE}" fill-opacity="${LINE_ALPHA * 1.6}"/>`,
        );
      }
    }

    taken.forEach((t, i) => {
      const x = xOf(i);
      for (const [staff, notes] of [
        [TREBLE, split.treble],
        [BASS, split.bass],
      ] as const) {
        const chord = notes.filter((x) => x.start === t);
        if (chord.length > 0)
          parts.push(drawChord(staff, chord, x, spell, speller));
      }
    });
  }

  return svgDocument(parts.join(""));
}

/**
 * Which notes go on which staff: the track with the highest mean pitch on the
 * treble, the lowest on the bass — a piano score's right and left hands. A
 * single track (or none distinguishable) is split at middle C. Tracks between
 * the two are left out; a cover shows the outer voices.
 */
function splitStaves(score: Score): { treble: Note[]; bass: Note[] } {
  const byTrack = new Map<string, Note[]>();
  for (const note of score.notes) {
    const list = byTrack.get(note.track);
    if (list) list.push(note);
    else byTrack.set(note.track, [note]);
  }
  const means = [...byTrack.entries()]
    .map(([track, notes]) => ({
      track,
      notes,
      mean: notes.reduce((s, x) => s + x.pitch, 0) / notes.length,
    }))
    .sort((a, b) => b.mean - a.mean || (a.track < b.track ? -1 : 1));

  if (means.length >= 2) {
    return {
      treble: [...means[0]!.notes],
      bass: [...means[means.length - 1]!.notes],
    };
  }
  const all = means[0]?.notes ?? [];
  return {
    treble: all.filter((x) => x.pitch >= 60),
    bass: all.filter((x) => x.pitch < 60),
  };
}

function diatonicIndex(sp: PitchSpelling): number {
  return sp.octave * 7 + STEPS.indexOf(sp.step);
}

/** Move `d` by octaves until it needs at most MAX_LEDGER ledger lines. */
function clampToStaff(s: Staff, d: number): number {
  const top = s.bottom + 8;
  let out = d;
  while (out > top + MAX_LEDGER * 2) out -= 7;
  while (out < s.bottom - MAX_LEDGER * 2) out += 7;
  return out;
}

function drawChord(
  s: Staff,
  chord: Note[],
  x: number,
  spell: (note: Note) => PitchSpelling,
  speller: ReturnType<typeof makeKeySpeller>,
): string {
  const out: string[] = [];
  const heads = chord
    .map((note) => {
      const sp = spell(note);
      return {
        d: clampToStaff(s, diatonicIndex(sp)),
        // In the key = its letter's diatonic alteration; anything else gets a mark.
        accidental: speller.diatonic(note.pitch) === null ? sp.alter : null,
        duration: note.duration,
      };
    })
    .sort((a, b) => a.d - b.d);
  const top = s.bottom + 8;
  const minD = heads[0]!.d;
  const maxD = heads[heads.length - 1]!.d;

  // Ledger lines, through the outermost head on each side.
  for (let d = top + 2; d <= maxD; d += 2) {
    out.push(
      `<rect x="${n(x - 6.5)}" y="${n(stepY(s, d) - 0.35)}" width="13" height="0.7" fill="${LINE}" fill-opacity="${LINE_ALPHA * 2}"/>`,
    );
  }
  for (let d = s.bottom - 2; d >= minD; d -= 2) {
    out.push(
      `<rect x="${n(x - 6.5)}" y="${n(stepY(s, d) - 0.35)}" width="13" height="0.7" fill="${LINE}" fill-opacity="${LINE_ALPHA * 2}"/>`,
    );
  }

  const longest = Math.max(...heads.map((h) => h.duration));
  const hollow = longest >= 2;
  for (const h of heads) {
    const y = stepY(s, h.d);
    out.push(
      hollow
        ? `<ellipse cx="${n(x)}" cy="${n(y)}" rx="3.9" ry="2.7" transform="rotate(-20 ${n(x)} ${n(y)})" fill="none" stroke="${INK}" stroke-width="1.3"/>`
        : `<ellipse cx="${n(x)}" cy="${n(y)}" rx="4" ry="2.9" transform="rotate(-20 ${n(x)} ${n(y)})" fill="${INK}"/>`,
    );
    if (h.accidental !== null && h.accidental !== 0) {
      out.push(
        `<text x="${n(x - 11)}" y="${n(y + 3)}" font-family="sans-serif" font-size="9" fill="${INK}">${h.accidental > 0 ? "♯" : "♭"}</text>`,
      );
    }
  }

  // A whole note (4 beats or more) has no stem.
  if (longest < 4) {
    const middle = s.bottom + 4;
    const up = (minD + maxD) / 2 < middle;
    const stemLen = 3.5 * GAP;
    if (up) {
      const y1 = stepY(s, minD);
      const y2 = stepY(s, maxD) - stemLen;
      out.push(
        `<rect x="${n(x + 3.2)}" y="${n(y2)}" width="0.9" height="${n(y1 - y2)}" fill="${INK}"/>`,
      );
    } else {
      const y1 = stepY(s, maxD);
      const y2 = stepY(s, minD) + stemLen;
      out.push(
        `<rect x="${n(x - 4.1)}" y="${n(y1)}" width="0.9" height="${n(y2 - y1)}" fill="${INK}"/>`,
      );
    }
  }
  return out.join("");
}
