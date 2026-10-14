/**
 * Parse a MusicXML document (`score-partwise`) into a Sonata `Score`.
 *
 * Pure TypeScript over `fast-xml-parser`, so the web compile, the web import
 * button and the server import path share one source of truth.
 *
 * Mapping:
 *  - Each `<part>` is a track; a part with several staves (a piano's grand
 *    staff) is one track per staff (`RH` / `LH` for two).
 *  - Time is quarter-note beats: a `<duration>` is `divisions` per quarter.
 *    `<chord/>`, `<backup>` and `<forward>` move the measure cursor; the
 *    `<duration>` is trusted, so dots and tuplets need no reading.
 *  - Tied notes (`<tie>` / `<tied>`) merge into one note.
 *  - Repeats and voltas are unrolled into the played order.
 *  - `<sound tempo>` (or a `<metronome>` mark when no sound tempo is given) →
 *    `tempoMap`; `<time>` → `timeSigMap`; `<key>` → `meta.key` and authored
 *    `key` annotations; `<harmony>` → authored `chord` annotations, spelled as a
 *    symbol the theory chord parser reads; `<sound><swing>` (or an unambiguous
 *    "Swing" / "Swung 16ths" direction) → `meta.swing`.
 *  - Velocity follows the last dynamic mark (`<dynamics>`, `<sound dynamics>`)
 *    or a note's own `dynamics` attribute; 80 (mf) before any.
 *
 * Ignored (they do not change what sounds or when): grace and cue notes,
 * clefs, beams, stems, slurs, articulations, lyrics, layout. Anything that would
 * change the timing and that this reader cannot represent throws a
 * {@link MusicXmlParseError} naming the element and the measure.
 */

import {
  beatToSeconds,
  scoreEndBeat,
  type Annotation,
  type ChordAnnotation,
  type ChordData,
  type KeySignature,
  type Note,
  type PitchSpelling,
  type Score,
  type Swing,
  type TempoEvent,
  type TimeSigEvent,
  type TrackMeta,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { parseChordSymbol } from "@plugins/apps/plugins/sonata/plugins/theory/core";
import {
  child,
  childText,
  childrenNamed,
  parseXml,
  type XmlElement,
} from "./xml";

/** A MusicXML document this reader cannot turn into a Score. */
export class MusicXmlParseError extends Error {
  /** The element at fault (`note`, `harmony`, `score-partwise`, …). */
  readonly element: string;
  /** The `number` of the measure it sits in, when inside one. */
  readonly measure: string | null;
  /** The id of the part it sits in, when inside one. */
  readonly part: string | null;

  constructor(
    element: string,
    reason: string,
    where: { measure?: string | null; part?: string | null } = {},
  ) {
    const measure = where.measure ?? null;
    const part = where.part ?? null;
    const at = [
      measure === null ? null : `measure ${measure}`,
      part === null ? null : `part ${part}`,
    ]
      .filter((s) => s !== null)
      .join(", ");
    super(`[musicxml] <${element}>${at ? ` in ${at}` : ""}: ${reason}`);
    this.name = "MusicXmlParseError";
    this.element = element;
    this.measure = measure;
    this.part = part;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BPM = 120;
const DEFAULT_VELOCITY = 80;
/** MusicXML's `dynamics` percentages are relative to forte at velocity 90. */
const FORTE_VELOCITY = 90;
/** Two onsets closer than this (beats) are the same instant. */
const EPS = 1e-6;
/** Guard against a malformed repeat structure looping forever. */
const MAX_PLAYED_MEASURES = 100_000;

const STEP_PC: Record<PitchSpelling["step"], number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** Velocity of each dynamic mark (`<dynamics>` child element names). */
const DYNAMIC_VELOCITY: Record<string, number> = {
  pppppp: 8,
  ppppp: 12,
  pppp: 16,
  ppp: 23,
  pp: 36,
  p: 49,
  mp: 64,
  mf: 80,
  f: 96,
  ff: 112,
  fff: 120,
  ffff: 124,
  fffff: 126,
  ffffff: 127,
  sf: 112,
  sfz: 112,
  sffz: 120,
  fz: 112,
  rf: 104,
  rfz: 104,
  sfp: 112,
  sfpp: 112,
  fp: 96,
  pf: 64,
  sfzp: 112,
};

/**
 * The chord-symbol suffix (as the theory parser reads it) for each MusicXML
 * `<kind>` value. `none` (N.C.) is handled apart; the functional kinds
 * (Neapolitan, augmented sixths, Tristan, pedal, other) have no symbol and throw.
 */
const KIND_SUFFIX: Record<string, string> = {
  major: "",
  minor: "m",
  augmented: "aug",
  diminished: "dim",
  dominant: "7",
  "major-seventh": "maj7",
  "minor-seventh": "m7",
  "diminished-seventh": "dim7",
  "augmented-seventh": "aug7",
  "half-diminished": "m7b5",
  "major-minor": "mM7",
  "major-sixth": "6",
  "minor-sixth": "m6",
  "dominant-ninth": "9",
  "major-ninth": "maj9",
  "minor-ninth": "m9",
  "dominant-11th": "9add11",
  "major-11th": "maj9add11",
  "minor-11th": "m9add11",
  "dominant-13th": "13",
  "major-13th": "maj9add13",
  "minor-13th": "m9add13",
  "suspended-second": "sus2",
  "suspended-fourth": "sus4",
  power: "no3",
};

// ---------------------------------------------------------------------------
// Per-measure content (measure-relative beats, before unrolling)
// ---------------------------------------------------------------------------

interface RawNote {
  /** Measure-relative onset, beats. */
  pos: number;
  duration: number;
  pitch: number;
  spelling?: PitchSpelling;
  staff: number;
  voice?: number;
  tieStart: boolean;
  tieStop: boolean;
  /** The note's own `dynamics` velocity, overriding the running dynamic. */
  velocity: number | null;
}

/** A chord symbol at a position; `null` data = N.C. (ends the previous chord). */
interface RawHarmony {
  pos: number;
  data: ChordData | null;
}

interface MeasureContent {
  /** The measure's `number` attribute, for error messages. */
  number: string;
  /** `implicit="yes"`: an incomplete bar (a pickup) whose content is its length. */
  implicit: boolean;
  /** Length in beats: the content's extent, at least a full bar unless implicit. */
  length: number;
  notes: RawNote[];
  harmonies: RawHarmony[];
  tempos: { pos: number; bpm: number }[];
  dynamics: { pos: number; velocity: number }[];
  time: { numerator: number; denominator: number } | null;
  key: KeySignature | null;
  swings: { pos: number; swing: Swing | "straight" }[];
  swingWords: Swing[];
  forwardRepeat: boolean;
  /** `times` of a backward repeat (2 = play twice), or null. */
  backwardRepeat: number | null;
  endingStart: number[] | null;
  endingStop: boolean;
}

interface PartContent {
  id: string;
  name: string | undefined;
  gmProgram: number | undefined;
  staves: number;
  measures: MeasureContent[];
}

interface PartInfo {
  name?: string;
  gmProgram?: number;
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

type Where = { measure: string | null; part: string | null };

function int(text: string | undefined, element: string, where: Where): number {
  const n = Number(text);
  if (text === undefined || text === "" || !Number.isInteger(n)) {
    throw new MusicXmlParseError(
      element,
      `expected an integer, got "${text ?? ""}"`,
      where,
    );
  }
  return n;
}

function num(text: string | undefined, element: string, where: Where): number {
  const n = Number(text);
  if (text === undefined || text === "" || !Number.isFinite(n)) {
    throw new MusicXmlParseError(
      element,
      `expected a number, got "${text ?? ""}"`,
      where,
    );
  }
  return n;
}

function accidentals(alter: number): string {
  return alter > 0 ? "#".repeat(alter) : "b".repeat(-alter);
}

function isStep(s: string): s is PitchSpelling["step"] {
  return s in STEP_PC;
}

function keyFromFifths(fifths: number, mode: string | undefined): KeySignature {
  const MAJOR = [
    "Cb",
    "Gb",
    "Db",
    "Ab",
    "Eb",
    "Bb",
    "F",
    "C",
    "G",
    "D",
    "A",
    "E",
    "B",
    "F#",
    "C#",
  ];
  const MINOR = [
    "Ab",
    "Eb",
    "Bb",
    "F",
    "C",
    "G",
    "D",
    "A",
    "E",
    "B",
    "F#",
    "C#",
    "G#",
    "D#",
    "A#",
  ];
  const minor = mode === "minor";
  const tonic = (minor ? MINOR : MAJOR)[fifths + 7];
  if (tonic === undefined) throw new Error(`fifths out of range: ${fifths}`);
  return { tonic, mode: minor ? "minor" : "major" };
}

/** `<ending number="1, 2">` / `"1-3"` → [1, 2] / [1, 2, 3]. */
function endingNumbers(text: string | undefined, where: Where): number[] {
  if (!text) throw new MusicXmlParseError("ending", "missing number", where);
  const out: number[] = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) out.push(i);
    } else if (/^\d+$/.test(part)) {
      out.push(Number(part));
    } else {
      throw new MusicXmlParseError(
        "ending",
        `unreadable ending number "${text}"`,
        where,
      );
    }
  }
  return out;
}

/**
 * A strict reading of a swing direction's words: "Swing", "Swung", optionally
 * followed by the swung value ("8ths", "eighths", "16ths", "sixteenths"). Anything
 * else (e.g. "Medium swing", "Swing feel ♪♪ = ♪³♪") is not trusted.
 */
function swingFromWords(words: string): Swing | null {
  const m = /^(?:swing|swung)(?:\s+(8ths|eighths|16ths|sixteenths))?$/i.exec(
    words.trim(),
  );
  if (!m) return null;
  const value = m[1]?.toLowerCase();
  return {
    unit: value === "16ths" || value === "sixteenths" ? 16 : 8,
    ratio: 2,
  };
}

/** `<sound><swing>` → a swing feel or `"straight"`. */
function readSwing(el: XmlElement, where: Where): Swing | "straight" {
  if (child(el, "straight")) return "straight";
  const first = num(childText(el, "first"), "first", where);
  const second = num(childText(el, "second"), "second", where);
  if (!(first > 0 && second > 0)) {
    throw new MusicXmlParseError(
      "swing",
      `first/second must be positive, got ${first}/${second}`,
      where,
    );
  }
  const type = childText(el, "swing-type") ?? "eighth";
  if (type !== "eighth" && type !== "16th") {
    throw new MusicXmlParseError(
      "swing-type",
      `unsupported swing type "${type}" (eighth or 16th)`,
      where,
    );
  }
  return { unit: type === "16th" ? 16 : 8, ratio: first / second };
}

/** `<harmony>` → ChordData, or null for N.C. */
function readHarmony(el: XmlElement, where: Where): ChordData | null {
  const kindEl = child(el, "kind");
  if (!kindEl) throw new MusicXmlParseError("harmony", "missing <kind>", where);
  const kind = kindEl.text;
  if (kind === "none") return null;
  const root = child(el, "root");
  if (!root) {
    const what = child(el, "function")
      ? "<function>"
      : child(el, "numeral")
        ? "<numeral>"
        : "no <root>";
    throw new MusicXmlParseError(
      "harmony",
      `unsupported chord without a root (${what})`,
      where,
    );
  }
  const rootStep = childText(root, "root-step") ?? "";
  if (!isStep(rootStep)) {
    throw new MusicXmlParseError(
      "root-step",
      `invalid step "${rootStep}"`,
      where,
    );
  }
  const rootAlter = int(
    childText(root, "root-alter") ?? "0",
    "root-alter",
    where,
  );

  const suffix = KIND_SUFFIX[kind];
  if (suffix === undefined) {
    throw new MusicXmlParseError(
      "kind",
      `unsupported chord kind "${kind}"`,
      where,
    );
  }

  let degrees = "";
  for (const d of childrenNamed(el, "degree")) {
    const value = int(childText(d, "degree-value"), "degree-value", where);
    const alter = int(
      childText(d, "degree-alter") ?? "0",
      "degree-alter",
      where,
    );
    const type = childText(d, "degree-type");
    if (type === "add")
      degrees +=
        alter === 0 ? `add${value}` : `(${accidentals(alter)}${value})`;
    else if (type === "alter") degrees += `(${accidentals(alter)}${value})`;
    else if (type === "subtract") degrees += `no${value}`;
    else
      throw new MusicXmlParseError(
        "degree-type",
        `unsupported degree type "${type ?? ""}"`,
        where,
      );
  }

  let bass = "";
  const bassEl = child(el, "bass");
  if (bassEl) {
    const bassStep = childText(bassEl, "bass-step") ?? "";
    if (!isStep(bassStep)) {
      throw new MusicXmlParseError(
        "bass-step",
        `invalid step "${bassStep}"`,
        where,
      );
    }
    bass = `/${bassStep}${accidentals(int(childText(bassEl, "bass-alter") ?? "0", "bass-alter", where))}`;
  }

  const symbol = `${rootStep}${accidentals(rootAlter)}${suffix}${degrees}${bass}`;
  const data = parseChordSymbol(symbol);
  if (!data) {
    throw new MusicXmlParseError(
      "harmony",
      `chord "${symbol}" is not a recognised chord symbol`,
      where,
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// Part reader (document order → per-measure content)
// ---------------------------------------------------------------------------

function readPart(partEl: XmlElement, info: PartInfo | undefined): PartContent {
  const partId = partEl.attrs.id ?? "";
  if (!partId) throw new MusicXmlParseError("part", "missing id");

  // Written-order state carried across measures.
  let divisions: number | null = null;
  let barLength: number | null = null;
  let staves = 1;
  let transposeSemis = 0;
  const measures: MeasureContent[] = [];

  for (const m of childrenNamed(partEl, "measure")) {
    const where: Where = {
      measure: m.attrs.number ?? String(measures.length + 1),
      part: partId,
    };
    const implicit = m.attrs.implicit === "yes";
    const content: MeasureContent = {
      number: where.measure ?? "",
      implicit,
      length: 0,
      notes: [],
      harmonies: [],
      tempos: [],
      dynamics: [],
      time: null,
      key: null,
      swings: [],
      swingWords: [],
      forwardRepeat: false,
      backwardRepeat: null,
      endingStart: null,
      endingStop: false,
    };

    let cursor = 0;
    let extent = 0;
    let lastStart = 0;

    const beats = (el: XmlElement, name: string): number => {
      if (divisions === null) {
        throw new MusicXmlParseError(
          name,
          "a duration before any <divisions>",
          where,
        );
      }
      return num(childText(el, name), name, where) / divisions;
    };
    const offsetOf = (el: XmlElement): number =>
      child(el, "offset") ? beats(el, "offset") : 0;

    /** Read a `<sound>`; true when it sets the tempo. */
    const readSound = (sound: XmlElement, pos: number): boolean => {
      for (const jump of ["dacapo", "dalsegno", "tocoda"]) {
        if (sound.attrs[jump] !== undefined) {
          throw new MusicXmlParseError(
            "sound",
            `unsupported playback jump (${jump})`,
            where,
          );
        }
      }
      let hasTempo = false;
      if (sound.attrs.tempo !== undefined) {
        const bpm = num(sound.attrs.tempo, "sound", where);
        if (bpm > 0) {
          content.tempos.push({ pos, bpm });
          hasTempo = true;
        }
      }
      if (sound.attrs.dynamics !== undefined) {
        const pct = num(sound.attrs.dynamics, "sound", where);
        content.dynamics.push({ pos, velocity: velocityFromPercent(pct) });
      }
      const swing = child(sound, "swing");
      if (swing) content.swings.push({ pos, swing: readSwing(swing, where) });
      return hasTempo;
    };

    for (const el of m.children) {
      switch (el.name) {
        case "attributes": {
          const div = childText(el, "divisions");
          if (div !== undefined) {
            divisions = num(div, "divisions", where);
            if (!(divisions > 0))
              throw new MusicXmlParseError(
                "divisions",
                "must be positive",
                where,
              );
          }
          const st = childText(el, "staves");
          if (st !== undefined)
            staves = Math.max(staves, int(st, "staves", where));
          const key = child(el, "key");
          if (key) {
            const fifths = childText(key, "fifths");
            if (fifths === undefined) {
              throw new MusicXmlParseError(
                "key",
                "non-traditional key signatures are unsupported",
                where,
              );
            }
            const f = int(fifths, "fifths", where);
            if (f < -7 || f > 7)
              throw new MusicXmlParseError(
                "fifths",
                `out of range: ${f}`,
                where,
              );
            content.key = keyFromFifths(f, childText(key, "mode"));
          }
          const time = child(el, "time");
          if (time) {
            if (child(time, "senza-misura")) {
              throw new MusicXmlParseError(
                "time",
                "unmetered music (senza-misura) is unsupported",
                where,
              );
            }
            const beatsEls = childrenNamed(time, "beats");
            const typeEls = childrenNamed(time, "beat-type");
            if (beatsEls.length !== 1 || typeEls.length !== 1) {
              throw new MusicXmlParseError(
                "time",
                "composite time signatures are unsupported",
                where,
              );
            }
            // "3+2" additive numerators sum to the bar's beat count.
            const numerator = beatsEls[0]!.text
              .split("+")
              .reduce((s, p) => s + int(p.trim(), "beats", where), 0);
            const denominator = int(typeEls[0]!.text, "beat-type", where);
            content.time = { numerator, denominator };
            barLength = numerator * (4 / denominator);
          }
          const transpose = child(el, "transpose");
          if (transpose) {
            transposeSemis =
              int(childText(transpose, "chromatic"), "chromatic", where) +
              12 *
                int(
                  childText(transpose, "octave-change") ?? "0",
                  "octave-change",
                  where,
                );
          }
          break;
        }
        case "note": {
          if (child(el, "grace")) break; // ornament: no time, not played here
          const isChord = child(el, "chord") !== undefined;
          const duration = beats(el, "duration");
          if (duration < 0)
            throw new MusicXmlParseError(
              "duration",
              "negative duration",
              where,
            );
          const start = isChord ? lastStart : cursor;
          if (!isChord) {
            lastStart = cursor;
            cursor += duration;
          }
          extent = Math.max(extent, start + duration);
          if (child(el, "rest") || child(el, "cue")) break;
          if (child(el, "unpitched")) {
            throw new MusicXmlParseError(
              "note",
              "unpitched (percussion) notes are unsupported",
              where,
            );
          }
          const pitchEl = child(el, "pitch");
          if (!pitchEl)
            throw new MusicXmlParseError(
              "note",
              "a note with neither <pitch> nor <rest>",
              where,
            );
          if (!(duration > 0))
            throw new MusicXmlParseError(
              "duration",
              "a sounding note needs a positive duration",
              where,
            );
          const step = childText(pitchEl, "step") ?? "";
          if (!isStep(step))
            throw new MusicXmlParseError(
              "step",
              `invalid step "${step}"`,
              where,
            );
          const alterText = childText(pitchEl, "alter") ?? "0";
          const alter = num(alterText, "alter", where);
          if (!Number.isInteger(alter)) {
            throw new MusicXmlParseError(
              "alter",
              `microtonal alteration ${alter} is unsupported`,
              where,
            );
          }
          const octave = int(childText(pitchEl, "octave"), "octave", where);
          const pitch =
            (octave + 1) * 12 + STEP_PC[step] + alter + transposeSemis;
          if (pitch < 0 || pitch > 127) {
            throw new MusicXmlParseError(
              "pitch",
              `${step}${octave} is outside the MIDI range`,
              where,
            );
          }
          const staff = int(childText(el, "staff") ?? "1", "staff", where);
          if (staff < 1)
            throw new MusicXmlParseError(
              "staff",
              `invalid staff ${staff}`,
              where,
            );
          staves = Math.max(staves, staff);
          const voiceText = childText(el, "voice");
          const ties = [
            ...childrenNamed(el, "tie"),
            ...childrenNamed(el, "notations").flatMap((n) =>
              childrenNamed(n, "tied"),
            ),
          ].map((t) => t.attrs.type);
          const dyn = el.attrs.dynamics;
          content.notes.push({
            pos: start,
            duration,
            pitch,
            // A transposing part's written spelling is not the sounding pitch's.
            ...(transposeSemis === 0
              ? { spelling: { step, alter, octave } }
              : {}),
            staff,
            ...(voiceText !== undefined
              ? { voice: int(voiceText, "voice", where) }
              : {}),
            tieStart: ties.includes("start") || ties.includes("continue"),
            tieStop: ties.includes("stop") || ties.includes("continue"),
            velocity:
              dyn === undefined
                ? null
                : velocityFromPercent(num(dyn, "note", where)),
          });
          break;
        }
        case "backup": {
          cursor -= beats(el, "duration");
          if (cursor < -EPS)
            throw new MusicXmlParseError(
              "backup",
              "moves before the start of the measure",
              where,
            );
          cursor = Math.max(cursor, 0);
          break;
        }
        case "forward": {
          cursor += beats(el, "duration");
          extent = Math.max(extent, cursor);
          break;
        }
        case "direction": {
          const pos = cursor + offsetOf(el);
          const sound = child(el, "sound");
          const hasSoundTempo = sound ? readSound(sound, pos) : false;
          for (const dt of childrenNamed(el, "direction-type")) {
            for (const d of dt.children) {
              if (d.name === "dynamics") {
                const mark = d.children[0]?.name;
                const velocity =
                  mark === undefined ? undefined : DYNAMIC_VELOCITY[mark];
                if (velocity !== undefined)
                  content.dynamics.push({ pos, velocity });
              } else if (d.name === "metronome" && !hasSoundTempo) {
                const bpm = metronomeBpm(d, where);
                if (bpm !== null) content.tempos.push({ pos, bpm });
              } else if (d.name === "words") {
                const swing = swingFromWords(d.text);
                if (swing) content.swingWords.push(swing);
              }
            }
          }
          break;
        }
        case "sound": {
          readSound(el, cursor);
          break;
        }
        case "harmony": {
          content.harmonies.push({
            pos: cursor + offsetOf(el),
            data: readHarmony(el, where),
          });
          break;
        }
        case "barline": {
          const repeat = child(el, "repeat");
          if (repeat) {
            const dir = repeat.attrs.direction;
            if (dir === "forward") content.forwardRepeat = true;
            else if (dir === "backward") {
              content.backwardRepeat =
                repeat.attrs.times === undefined
                  ? 2
                  : int(repeat.attrs.times, "repeat", where);
            } else {
              throw new MusicXmlParseError(
                "repeat",
                `invalid direction "${dir ?? ""}"`,
                where,
              );
            }
          }
          const ending = child(el, "ending");
          if (ending) {
            const type = ending.attrs.type;
            if (type === "start")
              content.endingStart = endingNumbers(ending.attrs.number, where);
            else if (type === "stop" || type === "discontinue")
              content.endingStop = true;
            else
              throw new MusicXmlParseError(
                "ending",
                `invalid type "${type ?? ""}"`,
                where,
              );
          }
          break;
        }
        default:
          // print, figured-bass, bookmark, link, grouping, … — no timing.
          break;
      }
    }

    content.length =
      implicit || barLength === null ? extent : Math.max(extent, barLength);
    measures.push(content);
  }

  return {
    id: partId,
    name: info?.name,
    gmProgram: info?.gmProgram,
    staves,
    measures,
  };
}

function velocityFromPercent(pct: number): number {
  return Math.max(1, Math.min(127, Math.round((pct / 100) * FORTE_VELOCITY)));
}

/** `<metronome>` → quarter-note bpm, or null when it states no number. */
function metronomeBpm(el: XmlElement, where: Where): number | null {
  const unit = childText(el, "beat-unit");
  const perMinute = childText(el, "per-minute");
  if (unit === undefined || perMinute === undefined) return null; // a metric modulation
  const n = /\d+(?:\.\d+)?/.exec(perMinute);
  if (!n) return null;
  const UNIT_QUARTERS: Record<string, number> = {
    whole: 4,
    half: 2,
    quarter: 1,
    eighth: 0.5,
    "16th": 0.25,
    "32nd": 0.125,
  };
  const quarters = UNIT_QUARTERS[unit];
  if (quarters === undefined) {
    throw new MusicXmlParseError(
      "beat-unit",
      `unsupported metronome unit "${unit}"`,
      where,
    );
  }
  const dots = childrenNamed(el, "beat-unit-dot").length;
  const dotted = quarters * (2 - 1 / 2 ** dots);
  return Number(n[0]) * dotted;
}

// ---------------------------------------------------------------------------
// Repeat unrolling
// ---------------------------------------------------------------------------

/**
 * The played order of measure indices: repeats taken `times` times, each volta
 * played on the passes its `number` names.
 */
function playOrder(
  measures: readonly MeasureContent[],
  partId: string,
): number[] {
  // Each measure's ending numbers (the whole span of a volta), and whether it is
  // the last measure of its span.
  const ending: (number[] | null)[] = measures.map(() => null);
  const endingLast: boolean[] = measures.map(() => false);
  let open: number[] | null = null;
  measures.forEach((m, i) => {
    if (m.endingStart) {
      if (open) {
        throw new MusicXmlParseError("ending", "starts inside another ending", {
          measure: m.number,
          part: partId,
        });
      }
      open = m.endingStart;
    }
    ending[i] = open;
    if (m.endingStop) {
      if (!open) {
        throw new MusicXmlParseError("ending", "stops without a start", {
          measure: m.number,
          part: partId,
        });
      }
      endingLast[i] = true;
      open = null;
    }
  });
  if (open) {
    throw new MusicXmlParseError("ending", "never stops", {
      measure: measures.at(-1)?.number ?? null,
      part: partId,
    });
  }

  const order: number[] = [];
  const jumps = new Map<number, number>(); // backward-repeat index → jumps taken
  let repeatStart = 0;
  let pass = 1;
  let i = 0;
  let arrivedByJump = false;
  while (i < measures.length) {
    if (order.length > MAX_PLAYED_MEASURES) {
      throw new MusicXmlParseError(
        "repeat",
        "the repeat structure never ends",
        { part: partId },
      );
    }
    const m = measures[i]!;
    if (m.forwardRepeat && !arrivedByJump) {
      repeatStart = i;
      pass = 1;
    }
    arrivedByJump = false;
    const numbers = ending[i];
    if (numbers && !numbers.includes(pass)) {
      // Skip this volta's whole span.
      while (i < measures.length && !endingLast[i]) i++;
      i++;
      continue;
    }
    order.push(i);
    if (m.backwardRepeat !== null) {
      const taken = jumps.get(i) ?? 0;
      if (taken < m.backwardRepeat - 1) {
        jumps.set(i, taken + 1);
        pass++;
        i = repeatStart;
        arrivedByJump = true;
        continue;
      }
      // Leaving the repeat: an un-marked later repeat starts after it.
      repeatStart = i + 1;
      pass = 1;
    } else if (numbers && endingLast[i]) {
      // The final volta, played through: the repeated section is over.
      repeatStart = i + 1;
      pass = 1;
    }
    i++;
  }
  return order;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/** The Score plus the document's composer (not part of the Score model). */
export interface ParsedMusicXml {
  score: Score;
  composer: string | null;
}

/** Parse a MusicXML document; throws {@link MusicXmlParseError}. */
export function parseMusicXmlDocument(xml: string): ParsedMusicXml {
  const doc = parseXml(xml);
  if (!doc.ok)
    throw new MusicXmlParseError(
      "document",
      `not well-formed XML: ${doc.message}`,
    );
  const root = doc.elements.find((e) => e.name.startsWith("score-"));
  if (!root || root.name !== "score-partwise") {
    throw new MusicXmlParseError(
      root?.name ?? "document",
      root
        ? "only score-partwise documents are supported"
        : "no <score-partwise> root element",
    );
  }

  // --- Header ----------------------------------------------------------
  const work = child(root, "work");
  const title =
    (work && childText(work, "work-title")) ||
    childText(root, "movement-title") ||
    undefined;
  const ident = child(root, "identification");
  const composer =
    (ident &&
      childrenNamed(ident, "creator").find((c) => c.attrs.type === "composer")
        ?.text) ||
    null;

  // --- Part list -------------------------------------------------------
  const infos = new Map<string, PartInfo>();
  const partList = child(root, "part-list");
  for (const sp of partList ? childrenNamed(partList, "score-part") : []) {
    const id = sp.attrs.id;
    if (!id) continue;
    const info: PartInfo = {};
    const name = childText(sp, "part-name");
    if (name) info.name = name;
    const program = childText(
      child(sp, "midi-instrument") ?? sp,
      "midi-program",
    );
    if (program !== undefined) {
      info.gmProgram =
        int(program, "midi-program", { measure: null, part: id }) - 1;
    }
    infos.set(id, info);
  }

  const parts = childrenNamed(root, "part").map((p) =>
    readPart(p, infos.get(p.attrs.id ?? "")),
  );
  if (parts.length === 0)
    throw new MusicXmlParseError("score-partwise", "no <part>");
  const measureCount = parts[0]!.measures.length;
  for (const p of parts) {
    if (p.measures.length !== measureCount) {
      throw new MusicXmlParseError(
        "part",
        `has ${p.measures.length} measures, the first part has ${measureCount}`,
        { part: p.id },
      );
    }
  }

  // --- Timeline: shared measure lengths, unrolled order ----------------
  const lengths = Array.from({ length: measureCount }, (_, i) =>
    Math.max(...parts.map((p) => p.measures[i]!.length)),
  );
  // Repeats are a score-wide structure; the first part's barlines carry it.
  const order = playOrder(parts[0]!.measures, parts[0]!.id);
  const instanceStart: number[] = [];
  let total = 0;
  for (const idx of order) {
    instanceStart.push(total);
    total += lengths[idx]!;
  }

  // An implicit opening bar is a pickup (anacrusis).
  const pickupBeats =
    parts[0]!.measures[0]?.implicit && order[0] === 0 ? lengths[0]! : 0;

  // --- Score-wide events (deduped across parts) ------------------------
  const tempoAt = new Map<number, number>();
  const timeSigs: TimeSigEvent[] = [];
  const keys: { beat: number; key: KeySignature }[] = [];
  const swings: Swing[] = [];
  let sawSwingElement = false;
  let sawStraight = false;
  const swingWords: Swing[] = [];
  const harmonies: RawHarmony[] = [];

  order.forEach((idx, k) => {
    const at = instanceStart[k]!;
    for (const p of parts) {
      const m = p.measures[idx]!;
      for (const t of m.tempos)
        if (!tempoAt.has(at + t.pos)) tempoAt.set(at + t.pos, t.bpm);
      if (m.time && !timeSigs.some((s) => Math.abs(s.beat - at) < EPS)) {
        timeSigs.push({ beat: at, ...m.time });
      }
      if (m.key && !keys.some((e) => Math.abs(e.beat - at) < EPS))
        keys.push({ beat: at, key: m.key });
      for (const s of m.swings) {
        sawSwingElement = true;
        // The Score has one swing feel for the whole piece: straight bars and
        // swung bars in one document cannot both be played as written.
        if (s.swing === "straight") sawStraight = true;
        else swings.push(s.swing);
        if (sawStraight && swings.length > 0) {
          throw new MusicXmlParseError(
            "swing",
            "a change between straight and swing mid-piece is unsupported",
            {
              measure: m.number,
              part: p.id,
            },
          );
        }
      }
      swingWords.push(...m.swingWords);
      for (const h of m.harmonies)
        harmonies.push({ pos: at + h.pos, data: h.data });
    }
  });

  // The `<swing>` element is authoritative; the words are a fallback only when
  // the document carries none.
  const allSwings = sawSwingElement ? swings : swingWords;
  const swing = allSwings[0];
  if (
    swing &&
    allSwings.some((s) => s.unit !== swing.unit || s.ratio !== swing.ratio)
  ) {
    throw new MusicXmlParseError(
      "swing",
      "a swing change mid-piece is unsupported",
    );
  }

  let tempoMap: TempoEvent[] = [...tempoAt.entries()]
    .map(([beat, bpm]) => ({ beat, bpm }))
    .sort((a, b) => a.beat - b.beat)
    // Collapse repeats of the same tempo (each repeated measure restates it).
    .filter((t, i, all) => i === 0 || all[i - 1]!.bpm !== t.bpm);
  if (tempoMap.length === 0) tempoMap = [{ beat: 0, bpm: DEFAULT_BPM }];

  let timeSigMap = timeSigs
    .sort((a, b) => a.beat - b.beat)
    .filter(
      (t, i, all) =>
        i === 0 ||
        all[i - 1]!.numerator !== t.numerator ||
        all[i - 1]!.denominator !== t.denominator,
    );
  if (timeSigMap.length === 0)
    timeSigMap = [{ beat: 0, numerator: 4, denominator: 4 }];

  keys.sort((a, b) => a.beat - b.beat);
  const keyEvents = keys.filter(
    (e, i) =>
      i === 0 ||
      e.key.tonic !== keys[i - 1]!.key.tonic ||
      e.key.mode !== keys[i - 1]!.key.mode,
  );

  // --- Tracks and notes ------------------------------------------------
  const tracks: TrackMeta[] = [];
  const notes: Note[] = [];
  for (const p of parts) {
    const trackId = (staff: number): string =>
      p.staves > 1 ? `${p.id}-s${staff}` : p.id;
    const trackName = (staff: number): string | undefined => {
      if (p.staves === 1) return p.name;
      const label =
        p.staves === 2 ? (staff === 1 ? "RH" : "LH") : `staff ${staff}`;
      return p.name ? `${p.name} ${label}` : label;
    };

    // Lay the part's notes out on the unrolled timeline, velocity from the
    // running dynamic in played order.
    let velocity = DEFAULT_VELOCITY;
    const placed: (RawNote & { start: number; vel: number })[] = [];
    order.forEach((idx, k) => {
      const at = instanceStart[k]!;
      const m = p.measures[idx]!;
      const dyn = [...m.dynamics].sort((a, b) => a.pos - b.pos);
      let di = 0;
      for (const n of [...m.notes].sort((a, b) => a.pos - b.pos)) {
        while (di < dyn.length && dyn[di]!.pos <= n.pos + EPS)
          velocity = dyn[di++]!.velocity;
        placed.push({ ...n, start: at + n.pos, vel: n.velocity ?? velocity });
      }
      while (di < dyn.length) velocity = dyn[di++]!.velocity;
    });

    // Merge ties: a tie-stop continues the open note of the same pitch on the
    // same staff that ends where it starts.
    const open = new Map<string, Note>();
    const partNotes: Note[] = [];
    for (const n of placed) {
      const key = `${n.staff}:${n.pitch}`;
      const prev = n.tieStop ? open.get(key) : undefined;
      let note: Note;
      if (prev && Math.abs(prev.start + prev.duration - n.start) < EPS) {
        prev.duration += n.duration;
        note = prev;
      } else {
        note = {
          id: "",
          pitch: n.pitch,
          ...(n.spelling ? { spelling: n.spelling } : {}),
          start: n.start,
          duration: n.duration,
          velocity: n.vel,
          track: trackId(n.staff),
          ...(n.voice !== undefined ? { voice: n.voice } : {}),
        };
        partNotes.push(note);
      }
      if (n.tieStart) open.set(key, note);
      else open.delete(key);
    }

    const used = new Set(partNotes.map((n) => n.track));
    for (let staff = 1; staff <= p.staves; staff++) {
      const id = trackId(staff);
      if (!used.has(id)) continue;
      const name = trackName(staff);
      tracks.push({
        id,
        ...(name ? { name } : {}),
        ...(p.gmProgram !== undefined ? { gmProgram: p.gmProgram } : {}),
      });
    }
    notes.push(...partNotes);
  }

  const counters = new Map<string, number>();
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  for (const n of notes) {
    const i = counters.get(n.track) ?? 0;
    counters.set(n.track, i + 1);
    n.id = `${n.track}-n${i}`;
  }

  // --- Annotations -----------------------------------------------------
  const end = Math.max(total, ...notes.map((n) => n.start + n.duration));
  harmonies.sort((a, b) => a.pos - b.pos);
  const chordAnnotations: ChordAnnotation[] = [];
  harmonies.forEach((h, i) => {
    // The same chord stated by two parts at one beat is one chord.
    if (i > 0 && Math.abs(harmonies[i - 1]!.pos - h.pos) < EPS) return;
    if (!h.data) return;
    const next = harmonies.slice(i + 1).find((x) => x.pos > h.pos + EPS);
    chordAnnotations.push({
      type: "chord",
      start: h.pos,
      end: next ? next.pos : end,
      data: h.data,
      source: "authored",
    });
  });
  const keyAnnotations: Annotation[] = keyEvents.map((e, i) => ({
    type: "key",
    start: e.beat,
    end: i + 1 < keyEvents.length ? keyEvents[i + 1]!.beat : end,
    data: e.key,
    source: "authored",
  }));

  const score: Score = {
    meta: {
      ...(title ? { title } : {}),
      ...(keyEvents[0] ? { key: keyEvents[0].key } : {}),
      ...(pickupBeats > 0 ? { pickupBeats } : {}),
      ...(swing && swing.ratio !== 1 ? { swing } : {}),
    },
    tracks,
    tempoMap,
    timeSigMap,
    notes,
    annotations: [...keyAnnotations, ...chordAnnotations],
    pedalEvents: [],
  };
  return { score, composer };
}

/**
 * Compile a MusicXML document's text into a Score. The `SonataDocument.Source`
 * compile: `raw` is the document text the source's hydrate fetched.
 */
export function parseMusicXml(raw: unknown): Score {
  if (typeof raw !== "string") {
    throw new Error(
      `[musicxml source] parseMusicXml() expected the document text, got ${typeof raw}`,
    );
  }
  return parseMusicXmlDocument(raw).score;
}

/** The library song metadata a MusicXML document carries. */
export interface MusicXmlSongMeta {
  /** The document's work / movement title, or null when it names none. */
  title: string | null;
  composer: string | null;
  durationSec: number;
  endBeat: number;
}

/** Parse a MusicXML document for the metadata the library row stores. */
export function deriveMusicXmlSongMeta(xml: string): MusicXmlSongMeta {
  const { score, composer } = parseMusicXmlDocument(xml);
  const endBeat = scoreEndBeat(score);
  return {
    title: score.meta.title ?? null,
    composer,
    durationSec: beatToSeconds(score, endBeat),
    endBeat,
  };
}

/** A song title from a file name: the name without its MusicXML extension. */
export function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.(musicxml|xml)$/i, "");
}
