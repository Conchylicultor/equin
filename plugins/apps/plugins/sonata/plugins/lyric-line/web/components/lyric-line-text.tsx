import type { CSSProperties } from "react";
import type {
  LyricAnnotation,
  LyricChord,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import "./lyric-line.css";

/** How a caller paints one chord name over the words. */
export interface LyricChordStyle {
  className?: string;
  style?: CSSProperties;
}

export interface LyricLineTextProps {
  /** The songsheet line: its words and the chords printed over them. */
  lyric: LyricAnnotation;
  /** Index (into `lyric.data.chords`) of the chord sounding now, or null when
   *  none of this line's chords is. */
  activeChord: number | null;
  /** Paints a chord name; `active` is true for the sounding one. Omitted, the
   *  chords read in the primary colour, the sounding one stronger and bold. */
  chordStyle?: (chord: LyricChord, active: boolean) => LyricChordStyle;
  /** The text a chord is printed as. Omitted, its symbol as written. A label
   *  longer than the symbol (a numeral beside it) pushes the chords after it
   *  right, so two chords never overprint. */
  chordLabel?: (chord: LyricChord) => string;
  /** Type role of both rows: `body` (default) on a reading surface, `caption`
   *  for a compact one floating over another view. */
  variant?: "body" | "caption";
  /**
   * How the chords sit over the words:
   *
   * - `columns` (default) — the songbook: a monospace chord row over a
   *   monospace lyric row, each chord pinned to its character column.
   * - `words` — in the surface's own font: the line flows as words that wrap,
   *   and each word a chord starts on carries that chord just above it. The
   *   words before the sounding chord read as sung (`data-sung`), the word it
   *   starts on as now (`data-now`), for the caller's CSS.
   */
  layout?: "columns" | "words";
}

function symbolLabel(chord: LyricChord): string {
  return chord.symbol;
}

/**
 * The column each chord is printed at: over its own syllable
 * (`charOffset`), or — when the label before it runs that far — one column
 * past that label, so labels never overlap.
 */
function chordColumns(
  labels: readonly string[],
  chords: readonly LyricChord[],
) {
  const columns: number[] = [];
  let free = 0;
  chords.forEach((c, i) => {
    const col = Math.max(c.charOffset, free);
    columns.push(col);
    free = col + labels[i]!.length + 1;
  });
  return columns;
}

function defaultChordStyle(_: LyricChord, active: boolean): LyricChordStyle {
  return {
    className: active
      ? "font-bold text-primary-text"
      : "font-semibold text-primary-text/70",
  };
}

/**
 * One songsheet line as text: a chord row (each chord pinned over its lyric
 * column) stacked over the lyric row, in a monospace `whitespace-pre` context
 * so `1ch` is exactly one printed column — chords land over the syllable they
 * sound on, classic-songbook style. No chrome of its own: the caller frames it
 * (a seek button, a grid cell) and decides how the chords are painted.
 */
export function LyricLineText({
  lyric,
  activeChord,
  chordStyle = defaultChordStyle,
  chordLabel = symbolLabel,
  variant = "body",
  layout = "columns",
}: LyricLineTextProps) {
  if (layout === "words") {
    return (
      <LyricWords
        lyric={lyric}
        activeChord={activeChord}
        chordStyle={chordStyle}
        chordLabel={chordLabel}
        variant={variant}
      />
    );
  }
  const { text, chords } = lyric.data;
  const labels = chords.map(chordLabel);
  const columns = chordColumns(labels, chords);
  // The chords are placed absolutely, so they add no width of their own: the
  // row claims the columns its last label runs to, so a chord past the end of
  // the words widens the line instead of overflowing (and being clipped by) it.
  const chordsEnd =
    chords.length === 0 ? 0 : columns.at(-1)! + labels.at(-1)!.length;
  return (
    <Stack gap="none">
      {/* Chord row: monospace baseline; each chord pinned to its column via
          an inline `left: <charOffset>ch` (a computed geometric value, not a
          spacing token). `whitespace-pre` keeps the empty row's height. */}
      <Text
        variant={variant}
        as="div"
        // `relative` is the positioning context the absolutely-placed
        // chords below need.
        className="relative h-[1.5em] whitespace-pre font-mono font-semibold"
        // A computed column count (one `ch` per printed character).
        style={{ minWidth: `${chordsEnd}ch` }}
      >
        {chords.length === 0
          ? " "
          : chords.map((c, i) => {
              const paint = chordStyle(c, i === activeChord);
              return (
                // Pinned to its exact monospace column: `start` is a computed
                // `ch` offset (one column = one char), not a spacing token.
                <Placed
                  key={i}
                  as="span"
                  x={{ start: `${columns[i]!}ch` }}
                  y={{ end: 0 }}
                >
                  <Text
                    as="span"
                    className={cn("font-mono", paint.className)}
                    style={paint.style}
                  >
                    {labels[i]}
                  </Text>
                </Placed>
              );
            })}
      </Text>

      {/* Lyric row: the raw text, leading spaces preserved. An empty line
          renders a non-breaking space so the row keeps its height. */}
      <Text
        variant={variant}
        as="div"
        tone={text.trim().length === 0 ? "muted" : "default"}
        className="whitespace-pre font-mono"
      >
        {text.length === 0 ? " " : text}
      </Text>
    </Stack>
  );
}

/** One word of a `words` line, and the chord (by index) it starts, if any. */
interface LyricWord {
  text: string;
  chord: number | null;
  /** The chord sounding over this word: the last chord at or before it. */
  under: number | null;
}

/**
 * A line's words, each carrying the chord that starts on it. The text is cut
 * at every chord's printed column first (a chord can start mid-word), then
 * each piece into words; the first word of a piece takes the piece's chord.
 * The columns are the `columns` layout's ({@link chordColumns}), so a chord the
 * one before it pushed right lands where the songbook prints it — past the
 * words, over nothing — rather than splitting the last word.
 */
function lyricWords(
  text: string,
  chords: readonly LyricChord[],
  labels: readonly string[],
): LyricWord[] {
  const cuts = chordColumns(labels, chords).map((col) =>
    Math.min(Math.max(col, 0), text.length),
  );
  const words: LyricWord[] = [];
  let under: number | null = null;
  const pushPiece = (piece: string, chord: number | null) => {
    if (chord !== null) under = chord;
    const tokens = piece.match(/\S+\s*|\s+/g) ?? [];
    if (tokens.length === 0 && chord !== null) {
      // A chord past the words: a word of its own, nothing under it.
      words.push({ text: "", chord, under });
      return;
    }
    tokens.forEach((t, i) =>
      words.push({ text: t, chord: i === 0 ? chord : null, under }),
    );
  };
  pushPiece(text.slice(0, cuts[0] ?? text.length), null);
  cuts.forEach((at, i) =>
    pushPiece(text.slice(at, cuts[i + 1] ?? text.length), i),
  );
  return words;
}

/** The `words` layout — see {@link LyricLineTextProps.layout}. */
function LyricWords({
  lyric,
  activeChord,
  chordStyle,
  chordLabel,
  variant,
}: Required<Omit<LyricLineTextProps, "layout">>) {
  const { text, chords } = lyric.data;
  const words = lyricWords(text, chords, chords.map(chordLabel));
  return (
    <Text variant={variant} as="div" className="sonata-lyric-words">
      {words.length === 0
        ? " "
        : words.map((w, i) => {
            const paint =
              w.chord === null
                ? null
                : chordStyle(chords[w.chord]!, w.chord === activeChord);
            return (
              <span
                key={i}
                className="sonata-lyric-word"
                data-sung={
                  activeChord !== null &&
                  w.under !== null &&
                  w.under < activeChord
                    ? true
                    : undefined
                }
                data-now={
                  activeChord !== null && w.under === activeChord
                    ? true
                    : undefined
                }
              >
                {/* The chord row, empty over a word no chord starts on — it
                    still holds the row's height. */}
                <span
                  className={cn("sonata-lyric-chord", paint?.className)}
                  style={paint?.style}
                >
                  {paint !== null && w.chord !== null
                    ? chordLabel(chords[w.chord]!)
                    : null}
                </span>
                {/* A chord past the words has no text: a non-breaking
                    space keeps the text row's height, so the chord still
                    sits above the line rather than on it. */}
                <span>{w.text.replace(/ /g, "\u00a0") || "\u00a0"}</span>
              </span>
            );
          })}
    </Text>
  );
}
