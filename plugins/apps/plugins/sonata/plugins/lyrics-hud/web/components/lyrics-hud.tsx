import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useCursorSelector,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { usePlayerView } from "@plugins/apps/plugins/sonata/plugins/player/web";
import type {
  LyricAnnotation,
  LyricChord,
  SectionAnnotation,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  activeLyricChord,
  currentLyricLine,
  groupLyricLines,
  lyricChordReadings,
  lyricLines,
  sameActiveChord,
  type ActiveChord,
} from "@plugins/apps/plugins/sonata/plugins/lyric-line/core";
import {
  LyricLineText,
  type LyricChordStyle,
} from "@plugins/apps/plugins/sonata/plugins/lyric-line/web";
import { chordToneStyle } from "@plugins/music/plugins/chord-box/web";
import { useChordDisplayMode } from "@plugins/apps/plugins/sonata/plugins/rich/plugins/chord-label/web";
import { formatChordLabel } from "@plugins/apps/plugins/sonata/plugins/theory/core";
import {
  asSonataLook,
  SONATA_LOOK_STYLES,
  sonataLookConfig,
} from "@plugins/apps/plugins/sonata/plugins/look/core";
import { useConfig } from "@plugins/config_v2/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { LYRICS_HUD_DISPLAYS, lyricsHudConfig } from "../../shared/config";
import "./lyrics-hud.css";

/** How many lines the corner shows at once: the current one and the next two. */
const VISIBLE_LINES = 3;

/** One row of the corner: a lyric line, headed by its section's name when it
 *  opens one. */
interface Row {
  line: LyricAnnotation;
  /** Index in the flat `lines` list (what the cursor selectors return). */
  index: number;
  section: SectionAnnotation | null;
}

/**
 * The lyrics corner — a Sonata HUD under the key chip. Shows the line in
 * progress and the next two, chords over the words (each in the colour of the
 * chord sounding at its beat); the rest stay a scroll away, and a click on a
 * line seeks there. No card: a frosted backing (`lyrics-hud.css`) blurs and
 * covers the notes behind the text, its edges feathered into the roll.
 *
 * Shown only on the lenses that have no lyrics of their own
 * (`LYRICS_HUD_DISPLAYS`) and only when the user turned it on in the View
 * popover; a song without lyrics shows nothing.
 */
export function LyricsHud() {
  const { displayId } = usePlayerView();
  const on = useConfig(lyricsHudConfig).lyrics;
  const { score } = useSession();
  const lines = useMemo(() => lyricLines(score), [score]);
  if (
    !on ||
    displayId === null ||
    !LYRICS_HUD_DISPLAYS.includes(displayId) ||
    lines.length === 0
  ) {
    return null;
  }
  return <LyricsCorner lines={lines} />;
}

function LyricsCorner({ lines }: { lines: LyricAnnotation[] }) {
  const { score, seekTo } = useSession();

  const rows = useMemo<Row[]>(() => {
    const sections = score.annotations.filter(
      (a): a is SectionAnnotation => a.type === "section",
    );
    return groupLyricLines(lines, sections).flatMap((g) =>
      g.lines.map(({ line, index }, i) => ({
        line,
        index,
        section: i === 0 ? g.section : null,
      })),
    );
  }, [score.annotations, lines]);

  const readings = useMemo(
    () => lyricChordReadings(score, lines),
    [score, lines],
  );
  // Chords are labelled the way every other chord surface is (the shared
  // Chord labels mode): the score's chord at that beat, as a name, a numeral
  // or both; the tab's own symbol where the score has no chord there.
  const mode = useChordDisplayMode();
  const chordLabel = (c: LyricChord): string => {
    const r = readings.get(c);
    return r?.chord ? formatChordLabel(r.chord, r.key, mode) : c.symbol;
  };

  // The corner sits on the bare lane, which wears the look's palette, not the
  // theme's: its backing is the lane's own ground and its words the lane's ink,
  // so it melts into the roll in every theme and look.
  const lane =
    SONATA_LOOK_STYLES[asSonataLook(useConfig(sonataLookConfig).look)];

  // Re-render only when the playhead crosses into another line / chord.
  const current = useCursorSelector(
    (beat) => currentLyricLine(lines, beat),
    [lines],
  );
  const activeChord = useCursorSelector<ActiveChord | null>(
    (beat) => activeLyricChord(lines, beat),
    [lines],
    sameActiveChord,
  );

  // The roll's own wheel listener (native, on the lane) seeks and cancels the
  // scroll; a wheel over the corner scrolls its list instead. Native too: a
  // React handler runs at the root, after the lane's.
  const cornerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = cornerRef.current;
    if (!el) return;
    const keep = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", keep);
    return () => el.removeEventListener("wheel", keep);
  }, []);

  // Fit the viewport to the current line (with its section name) and the next
  // two, and scroll it to the top; earlier and later lines stay a scroll away.
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const first = Math.max(current, 0);
    const top = rowRefs.current[first];
    const bottom =
      rowRefs.current[Math.min(first + VISIBLE_LINES - 1, rows.length - 1)];
    if (!top || !bottom) return;
    setHeight(bottom.offsetTop + bottom.offsetHeight - top.offsetTop);
    // Only the corner's own list scrolls: the roll around it stays put.
    revealElement(top, {
      behavior: "smooth",
      block: "start",
      scope: "nearest",
    });
  }, [current, rows]);

  return (
    // The HUD sits inside the roll's drag-to-scrub surface, whose pointerdown
    // takes pointer capture (a press would scrub instead of seek): keep the
    // press for the corner.
    <div
      ref={cornerRef}
      className="lyrics-hud"
      style={{ color: lane.laneInk }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* The frosted backing: the lane's ground, near-opaque, over a blur. */}
      <div
        aria-hidden
        className="lyrics-hud-backing"
        style={{
          backgroundColor: `color-mix(in oklab, ${lane.laneBg} 92%, transparent)`,
        }}
      />
      <Scroll
        axis="y"
        hideScrollbar
        className="lyrics-hud-scroll"
        style={{ height }}
      >
        {rows.map(({ line, index, section }) => {
          const now = index === current;
          const chordStyle = (
            c: LyricChord,
            active: boolean,
          ): LyricChordStyle => ({
            className:
              active && now
                ? "lyrics-hud-chord lyrics-hud-chord-now font-bold"
                : "lyrics-hud-chord font-semibold",
            style: chordToneStyle(readings.get(c)?.degree ?? null),
          });
          return (
            <button
              key={index}
              ref={(el) => {
                rowRefs.current[index] = el;
              }}
              type="button"
              className="lyrics-hud-row"
              data-now={now || undefined}
              data-past={index < current || undefined}
              onClick={() => seekTo(line.start)}
            >
              {section !== null ? (
                <Text variant="eyebrow" as="div" className="lyrics-hud-section">
                  {section.data.name}
                </Text>
              ) : null}
              <div className="lyrics-hud-line">
                <LyricLineText
                  lyric={line}
                  activeChord={
                    activeChord?.line === index ? activeChord.chord : null
                  }
                  chordStyle={chordStyle}
                  chordLabel={chordLabel}
                  variant="caption"
                />
              </div>
            </button>
          );
        })}
      </Scroll>
    </div>
  );
}
