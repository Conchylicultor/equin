import { useEffect, useMemo, useRef } from "react";
import {
  useCursorSelector,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { scrollChildIntoView } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import {
  chordBars,
  effectiveKeyAt,
  type ChordAnnotation,
  type ChordBar,
  type ChordBarSegment,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { formatChordLabel } from "@plugins/apps/plugins/sonata/plugins/theory/core";
import { useChordDisplayMode } from "@plugins/apps/plugins/sonata/plugins/rich/plugins/chord-label/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * The chord-progression strip — the BODY of a `Sonata.Section` card whose chrome
 * (Card + collapsible "Progression" title) the host paints. Renders the whole
 * progression as a lead sheet: one bar per line, each chord chip sized by its
 * beat-duration so the rhythm is visible at a glance. The strip scrolls with the
 * song — the bar under the playhead is kept centred in a bounded scroll viewport
 * — and the active chip highlights (both tracked via `useCursorSelector`, so the
 * panel reconciles only on bar / chord boundaries, not every frame). Clicking a
 * chip seeks to that chord.
 *
 * Each chip's text follows the shared chord-label mode (`symbol` / `roman` /
 * `both`) via `formatChordLabel` — the same label the piano-roll overlay shows —
 * so the two chord surfaces stay in lockstep. The section's header action
 * (`ChordLabelModeAction`) cycles that mode in place.
 *
 * Chips carry no degree colour: neutral (`secondary`) at rest, filled primary
 * under the playhead — the strip reads as rhythm and position, while the chord
 * list beside it owns the harmonic colouring.
 *
 * Applicability is the contribution's `useAvailable` (`useHasChords`): the card
 * is not painted at all for a chordless song, so this body never renders empty.
 */
export function ChordProgression() {
  const { score, seekTo } = useSession();
  const mode = useChordDisplayMode();

  const chords = useMemo(
    () =>
      score.annotations.filter((a): a is ChordAnnotation => a.type === "chord"),
    [score.annotations],
  );

  const barLines = useMemo(() => chordBars(score), [score]);

  // The displayed label per chord under the active mode, resolved against the
  // key in force at each chord's onset (a chord's function follows the key, which
  // can change mid-song via `key` annotations). Keyed by the stable chord
  // reference so chips read it by identity, and memoized on the Score + mode so
  // it never recomputes on a cursor frame.
  const labelByChord = useMemo(() => {
    const m = new Map<ChordAnnotation, string>();
    for (const c of chords) {
      m.set(
        c,
        formatChordLabel(c.data, effectiveKeyAt(score, c.start) ?? null, mode),
      );
    }
    return m;
  }, [score, chords, mode]);

  // Stable reference of the chord under the playhead (from the memoized `chords`
  // array, so chips can match by `===`). Falls back to the first chord at the
  // start so the strip isn't un-highlighted before playback begins.
  const active = useCursorSelector(
    (beat) =>
      chords.find((c) => beat >= c.start && beat < c.end) ??
      (beat <= 0 ? chords[0] : undefined),
    [chords],
  );

  // Index of the bar that owns the playhead — drives the auto-scroll. Reconciles
  // only when the playhead crosses a bar boundary (the selector bails otherwise).
  const activeBar = useCursorSelector(
    (beat) => {
      const i = barLines.findIndex(
        (l) => beat >= l.startBeat && beat < l.endBeat,
      );
      return i >= 0 ? i : beat <= 0 ? 0 : barLines.length - 1;
    },
    [barLines],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Re-centre the active bar within the strip container ONLY when the active
  // bar changes (the playhead crosses a bar boundary) — a container-scoped
  // scroll that never touches the surrounding pane.
  useEffect(() => {
    scrollChildIntoView(
      containerRef.current,
      rowRefs.current[activeBar] ?? null,
      {
        block: "center",
        behavior: "smooth",
      },
    );
  }, [activeBar]);

  return (
    // Bounded, self-scrolling lead sheet. Inline overflow/maxHeight + the
    // relative positioning context bound the scroll: `scrollChildIntoView`
    // re-centres the active bar within this container only, never the page.
    <div
      ref={containerRef}
      style={{
        position: "relative",
        maxHeight: "18rem",
        overflowY: "auto",
      }}
    >
      <ControlSizeProvider size="sm">
        <Stack gap="2xs">
          {barLines.map((line, i) => (
            <BarRow
              key={i}
              rowRef={(el) => {
                rowRefs.current[i] = el;
              }}
              line={line}
              active={active}
              labelByChord={labelByChord}
              onSeek={seekTo}
            />
          ))}
        </Stack>
      </ControlSizeProvider>
    </div>
  );
}

/** One bar on its own line: a rigid bar-number gutter plus the chord slices.
 *  The active bar is re-centred within the bounded strip container only
 *  (container-scoped, never scrolls the surrounding pane) by the parent, which
 *  reads each row via `rowRef`. */
function BarRow({
  line,
  active,
  labelByChord,
  onSeek,
  rowRef,
}: {
  line: ChordBar;
  active: ChordAnnotation | undefined;
  labelByChord: Map<ChordAnnotation, string>;
  onSeek: (beat: number) => void;
  rowRef?: (el: HTMLDivElement | null) => void;
}) {
  return (
    // Rigid, right-aligned number gutter (wide enough for three digits, so the
    // chip track starts at the same x on every row) + a flexible chip track that
    // owns the full bar width, so the per-chip weights map to real bar time.
    // Baseline alignment (not centring) puts the number on the first line of
    // chips: a crowded bar wraps onto several lines, and its number has to mark
    // where the bar STARTS, not float in the middle of the block.
    <div
      ref={rowRef}
      style={{
        display: "grid",
        gridTemplateColumns: "1.5rem minmax(0, 1fr)",
        alignItems: "baseline",
        gap: "0.375rem",
      }}
    >
      <Text variant="caption" tone="muted" className="text-right tabular-nums">
        {line.number}
      </Text>
      <BarBody
        segs={line.segs}
        active={active}
        labelByChord={labelByChord}
        onSeek={onSeek}
      />
    </div>
  );
}

/** A bar's chord slices as `minmax(0, fr)`-weighted chips — or a rest box. */
function BarBody({
  segs,
  active,
  labelByChord,
  onSeek,
}: {
  segs: ChordBarSegment[];
  active: ChordAnnotation | undefined;
  labelByChord: Map<ChordAnnotation, string>;
  onSeek: (beat: number) => void;
}) {
  if (segs.length === 0) {
    return (
      <div
        className="rounded-md bg-muted/30"
        // The height of the (sm-density) chips around it, so a rest bar holds
        // its line exactly like a chord bar.
        style={{ height: "var(--control-height-sm)" }}
        aria-hidden
      />
    );
  }
  const total = segs.reduce((sum, s) => sum + s.grow, 0);
  return (
    // A wrapping line, not a single grid row: every chip is at least as wide as
    // its own label (`min-width: min-content`, which beats the max below), and at
    // most as wide as the share of the bar its beats own (`max-width: <share>%`).
    // So a bar reads proportionally while its chords fit on one line — and once
    // they don't, the bar runs onto a second line instead of grinding its chips
    // down to unreadable slivers. Chips never shrink (`flexShrink: 0`), so the
    // break happens between chips, never inside a label.
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.1875rem",
      }}
    >
      {segs.map((seg, j) => (
        <ChordChip
          key={j}
          seg={seg}
          share={total > 0 ? seg.grow / total : 1}
          isActive={seg.chord === active}
          label={labelByChord.get(seg.chord) ?? seg.chord.data.symbol}
          onSeek={onSeek}
        />
      ))}
    </div>
  );
}

/** A single chord chip, sized by the share of the bar its beats own but never
 *  narrower than its own label; dimmed when it's a held carry-over. */
function ChordChip({
  seg,
  share,
  isActive,
  label,
  onSeek,
}: {
  seg: ChordBarSegment;
  /** Fraction of the bar's chord time this slice owns (0–1). */
  share: number;
  isActive: boolean;
  label: string;
  onSeek: (beat: number) => void;
}) {
  const { chord, isContinuation } = seg;
  return (
    <Button
      variant={isActive ? "default" : "secondary"}
      aria-pressed={isActive}
      onClick={() => onSeek(chord.start)}
      tooltip={`${chord.data.symbol} · beats ${chord.start.toFixed(2)}–${chord.end.toFixed(2)}`}
      className={cn("font-semibold", isContinuation && "opacity-40")}
      style={{
        // Grow by beat-weight, floor at the label, ceiling at the beats' share of
        // the bar. `minWidth` wins over `maxWidth` when they disagree (CSS resolves
        // min last), which is what keeps a short chord's label whole and pushes the
        // overflowing chips onto the next line instead of truncating them.
        flexGrow: seg.grow,
        flexShrink: 0,
        flexBasis: "auto",
        minWidth: "min-content",
        maxWidth: `${(share * 100).toFixed(4)}%`,
      }}
    >
      {label}
    </Button>
  );
}
