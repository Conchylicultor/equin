import {
  effectiveKeyAt,
  type ChordAnnotation,
  type ChordData,
  type KeySignature,
  type LyricAnnotation,
  type LyricChord,
  type Score,
  type SectionAnnotation,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { tonicPc } from "@plugins/apps/plugins/sonata/plugins/theory/core";
import {
  rootReading,
  type ScaleDegree,
} from "@plugins/music/plugins/chord-box/core";

const EPS = 1e-6;

/** Identity of the chord sounding now among the lyric lines: which line, and
 *  which of that line's `chords`. Compared by value ({@link sameActiveChord}). */
export interface ActiveChord {
  /** Index of the line in the list the chord was looked up in. */
  line: number;
  /** Index of the chord within that line's `chords`. */
  chord: number;
}

/** The score's songsheet lines (its `lyric` annotations), sorted by start. */
export function lyricLines(score: Score): LyricAnnotation[] {
  return score.annotations
    .filter((a): a is LyricAnnotation => a.type === "lyric")
    .sort((a, b) => a.start - b.start);
}

/**
 * The lyric chord sounding at `beat`: the chord printed over the lines whose
 * `beat` is the greatest at or before `beat` (a later line wins a tie, so a
 * chord repeated at the head of the next line takes over). `null` before the
 * first chord.
 */
export function activeLyricChord(
  lines: readonly LyricAnnotation[],
  beat: number,
): ActiveChord | null {
  let best: ActiveChord | null = null;
  let bestBeat = -Infinity;
  lines.forEach((l, li) => {
    l.data.chords.forEach((c, ci) => {
      if (c.beat <= beat + EPS && c.beat >= bestBeat) {
        bestBeat = c.beat;
        best = { line: li, chord: ci };
      }
    });
  });
  return best;
}

/** Value equality for {@link ActiveChord}, for a cursor selector's `equals`. */
export function sameActiveChord(
  a: ActiveChord | null,
  b: ActiveChord | null,
): boolean {
  return a?.line === b?.line && a?.chord === b?.chord;
}

/**
 * The line in progress at `beat`: the last line whose `start` is at or before
 * it — so a gap between two lines keeps the one just sung. `-1` before the
 * first line. For a surface that always shows "where we are" in the lyrics;
 * one that highlights only while a line is being sung tests `[start, end)`.
 */
export function currentLyricLine(
  lines: readonly LyricAnnotation[],
  beat: number,
): number {
  let current = -1;
  lines.forEach((l, i) => {
    if (l.start <= beat + EPS) current = i;
  });
  return current;
}

/**
 * Where the singing is: the line in progress ({@link currentLyricLine}) and
 * the piece of its words being sung — `piece` is the index of the line's last
 * chord at or before the beat, `-1` for the lead-in, the words before its
 * first chord (sung while the previous line's chord still sounds). Compared by
 * value ({@link sameLyricPosition}).
 */
export interface LyricPosition {
  /** Index of the line in the list the position was looked up in. */
  line: number;
  /** The piece of that line's words being sung: a chord index, or `-1`. */
  piece: number;
}

/** The {@link LyricPosition} at `beat`; `null` before the first line. */
export function lyricPosition(
  lines: readonly LyricAnnotation[],
  beat: number,
): LyricPosition | null {
  const line = currentLyricLine(lines, beat);
  if (line < 0) return null;
  let piece = -1;
  lines[line]!.data.chords.forEach((c, i) => {
    if (c.beat <= beat + EPS) piece = i;
  });
  return { line, piece };
}

/** Value equality for {@link LyricPosition}, for a cursor selector's `equals`. */
export function sameLyricPosition(
  a: LyricPosition | null,
  b: LyricPosition | null,
): boolean {
  return a?.line === b?.line && a?.piece === b?.piece;
}

/** Consecutive lyric lines under one section header (or under none). */
export interface LyricLineGroup {
  /** The section, or null for lines before/outside any section. */
  section: SectionAnnotation | null;
  /** The group's lines, each with its index in the flat `lines` list. */
  lines: { line: LyricAnnotation; index: number }[];
}

/**
 * Group the lyric lines under their containing section header, in order. A
 * line's section is the section annotation whose `[start, end]` contains the
 * line's `start` (the last match wins, so a later, tighter section overrides an
 * enclosing one); lines outside any section group under none. Consecutive lines
 * of the same section collapse into one group so its header prints once — the
 * same annotation, not the same name, so two "A" stanzas in a row keep a header
 * each.
 */
export function groupLyricLines(
  lines: readonly LyricAnnotation[],
  sections: readonly SectionAnnotation[],
): LyricLineGroup[] {
  const groups: LyricLineGroup[] = [];
  lines.forEach((line, index) => {
    let section: SectionAnnotation | null = null;
    for (const s of sections) {
      if (s.start <= line.start + EPS && s.end >= line.start - EPS) {
        section = s;
      }
    }
    const last = groups.at(-1);
    if (last && last.section === section) {
      last.lines.push({ line, index });
    } else {
      groups.push({ section, lines: [{ line, index }] });
    }
  });
  return groups;
}

/** How a lyric chord reads against the score: the score's own chord sounding
 *  at its beat, the key in force there, and the degree it is painted in. */
export interface LyricChordReading {
  /** The score's chord at the lyric chord's beat; `null` when none sounds. */
  chord: ChordData | null;
  /** The key in force at that chord; `null` for a keyless score (or no chord). */
  key: KeySignature | null;
  /** The numeral's number the chord box is painted in; `null` paints grey. */
  degree: ScaleDegree | null;
}

/**
 * How each lyric chord reads: the score's own chord sounding at that chord's
 * beat, read in the key in force there — so a chord over the words wears the
 * colour (and can take the numeral) its chord box does. Keyed by the score's
 * own lyric chord reference.
 */
export function lyricChordReadings(
  score: Score,
  lines: readonly LyricAnnotation[],
): Map<LyricChord, LyricChordReading> {
  const chords = score.annotations.filter(
    (a): a is ChordAnnotation => a.type === "chord",
  );
  const readings = new Map<LyricChord, LyricChordReading>();
  for (const l of lines) {
    for (const c of l.data.chords) {
      const chord = chords.find(
        (a) => a.start <= c.beat + EPS && a.end > c.beat + EPS,
      );
      const key =
        chord === undefined
          ? null
          : (effectiveKeyAt(score, chord.start) ?? null);
      readings.set(c, {
        chord: chord?.data ?? null,
        key,
        degree:
          chord === undefined || key === null
            ? null
            : rootReading(chord.data.root, tonicPc(key.tonic)).degree,
      });
    }
  }
  return readings;
}
