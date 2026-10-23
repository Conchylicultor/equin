import type {
  ChordData,
  KeySignature,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  romanNumeralParts,
  tonicName,
  tonicPc,
} from "@plugins/apps/plugins/sonata/plugins/theory/core";
import {
  rootReading,
  type ScaleDegree,
} from "@plugins/music/plugins/chord-box/core";
import type { ChordEvent } from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import { parseGrid, type KeyChange } from "../parse-grid";

/** One chord the cover draws: its tile colour, its numeral and its name. */
export interface CoverChord {
  /** The numeral's number against the tonic (`rootReading`) — the tile's colour. */
  degree: ScaleDegree;
  /** The degree as a Roman numeral, cased by quality (`I`, `vi`, `♭VII`). */
  numeral: string;
  /** The chord's root (`C`, `F♯`) — the head of its symbol. */
  root: string;
  /** The rest of the symbol (`maj7`, `m`, `/E`); `""` for a plain major triad. */
  suffix: string;
}

/** The most tiles a cover holds: a 3 × 2 grid. */
export const COVER_CHORD_LIMIT = 6;

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"] as const;
const ACCIDENTAL = { [-1]: "♭", 0: "", 1: "♯" } as const;

/** A symbol's root (letter + accidental) and the rest. */
const SYMBOL_HEAD = /^([A-G](?:[#♯b♭])?)(.*)$/;

/** The chord's display symbol (the key-spelled one when the parser made it). */
function symbolOf(data: ChordData): string {
  return data.spelledSymbol ?? data.symbol;
}

/** A chord struck, at the beat it is struck on. */
interface Strike {
  data: ChordData;
  start: number;
}

/**
 * The chords a grid strikes, in order, as written — each strike once: a hold
 * (`.`) already extends its chord in the parse, and the same chord struck
 * again straight after (`C C`) is one more bar of it, not a new chord.
 */
function strikes(events: readonly ChordEvent[]): Strike[] {
  const out: Strike[] = [];
  for (const ev of events) {
    const prev = out.at(-1);
    if (prev !== undefined && symbolOf(prev.data) === symbolOf(ev.data)) {
      continue;
    }
    out.push({ data: ev.data, start: ev.start });
  }
  return out;
}

/** The first `count` chord symbols of a grid — the Chords field's cell. */
export function gridChordNames(text: string, count: number): string[] {
  return strikes(parseGrid(text).events)
    .slice(0, count)
    .map((c) => symbolOf(c.data));
}

/** The key in force at `beat`: the last directive at or before it, else the first. */
function keyAt(keys: readonly KeyChange[], beat: number): KeySignature | null {
  let key: KeySignature | null = keys[0]?.key ?? null;
  for (const change of keys) {
    if (change.beat <= beat) key = change.key;
  }
  return key;
}

/**
 * The cover's chords for a grid: its first {@link COVER_CHORD_LIMIT} strikes
 (holds and repeats collapsed), each read against its tonic — the key a `key:`
 * directive declares (the one in force at the chord), or, when the grid
 * declares none, the first chord's root — so the tiles wear the same degree
 * colours the player's chord chart does.
 */
export function coverChords(text: string): CoverChord[] {
  const { events, keys } = parseGrid(text);
  const sequence = strikes(events);
  const first = sequence[0];
  if (first === undefined) return [];
  const fallback: KeySignature = {
    tonic: tonicName(((first.data.root % 12) + 12) % 12, "major"),
    mode: "major",
  };
  return sequence.slice(0, COVER_CHORD_LIMIT).map(({ data, start }) => {
    const key = keyAt(keys, start) ?? fallback;
    const reading = rootReading(data.root, tonicPc(key.tonic));
    const parts = romanNumeralParts(data, key);
    const symbol = symbolOf(data);
    const head = SYMBOL_HEAD.exec(symbol);
    return {
      degree: reading.degree,
      numeral:
        parts?.numeral ??
        ACCIDENTAL[reading.accidental] + ROMAN[reading.degree],
      root: head?.[1] ?? symbol,
      suffix: head?.[2] ?? "",
    };
  });
}
