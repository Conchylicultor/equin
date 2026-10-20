import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useCursorSelector,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { usePlayerView } from "@plugins/apps/plugins/sonata/plugins/player/web";
import type {
  LyricAnnotation,
  LyricChord,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  activeLyricChord,
  lyricChordReadings,
  lyricLines,
  lyricPosition,
  sameActiveChord,
  sameLyricPosition,
  type ActiveChord,
} from "@plugins/apps/plugins/sonata/plugins/lyric-line/core";
import {
  LyricLineText,
  type LyricChordStyle,
} from "@plugins/apps/plugins/sonata/plugins/lyric-line/web";
import { chordToneStyle } from "@plugins/music/plugins/chord-box/web";
import {
  asSonataLook,
  SONATA_LOOK_STYLES,
  sonataLookConfig,
} from "@plugins/apps/plugins/sonata/plugins/look/core";
import { useConfig } from "@plugins/config_v2/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { LYRICS_HUD_DISPLAYS, lyricsHudConfig } from "../../shared/config";
import "./lyrics-hud.css";

/** How many lines the corner shows at once: the current one and the next two. */
const VISIBLE_LINES = 3;

/** One row of the corner: a lyric line. */
interface Row {
  line: LyricAnnotation;
  /** Index in the flat `lines` list (what the cursor selectors return). */
  index: number;
}

/**
 * The lyrics corner — a Sonata HUD, a third of the way down the roll's right
 * side. Shows the line in progress and the next two, each chord over the word
 * it starts on — its symbol as the tab writes it, so the corner reads like the
 * songsheet, painted in the colour of the chord sounding at its beat; the rest stay
 * a scroll away, and a click on a line seeks there. No card: a soft backing
 * (`lyrics-hud.css`) blurs and dims the notes behind the text, its edges
 * feathered into the roll.
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

  const rows = useMemo<Row[]>(
    () => lines.map((line, index) => ({ line, index })),
    [lines],
  );

  const readings = useMemo(
    () => lyricChordReadings(score, lines),
    [score, lines],
  );
  // The corner sits on the bare lane, which wears the look's palette, not the
  // theme's: its backing is the lane's own ground and its words the lane's ink,
  // so it melts into the roll in every theme and look.
  const lane =
    SONATA_LOOK_STYLES[asSonataLook(useConfig(sonataLookConfig).look)];

  // Re-render only when the playhead crosses into another line, piece of its
  // words, or chord.
  const position = useCursorSelector(
    (beat) => lyricPosition(lines, beat),
    [lines],
    sameLyricPosition,
  );
  const current = position?.line ?? -1;
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

  // Fit the viewport to the current line and the next
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
  }, [current, rows]);
  // Reveal once the viewport has its height: before that the list does not
  // overflow, so there is nothing to scroll — a corner mounted mid-song (the
  // lens switched back to the roll) would otherwise stay on the first line.
  // The first reveal jumps; later ones glide as the song moves on.
  const revealed = useRef(false);
  useLayoutEffect(() => {
    if (height === undefined) return;
    // Only the corner's own list scrolls: the roll around it stays put.
    revealElement(rowRefs.current[Math.max(current, 0)], {
      behavior: revealed.current ? "smooth" : "instant",
      block: "start",
      scope: "nearest",
    });
    revealed.current = true;
  }, [current, rows, height]);

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
      {/* The backing: the lane's ground, mostly opaque, over a light blur,
          feathered out so it reads as no box at all. */}
      <div
        aria-hidden
        className="lyrics-hud-backing"
        style={{
          backgroundColor: `color-mix(in oklab, ${lane.laneBg} 72%, transparent)`,
          // The lane's ground also haloes the words, so a note passing behind
          // one cannot cut through it.
          ["--lyrics-halo" as string]: lane.laneBg,
        }}
      />
      <Scroll
        axis="y"
        hideScrollbar
        className="lyrics-hud-scroll"
        style={{ height }}
      >
        {rows.map(({ line, index }) => {
          const now = index === current;
          const chordStyle = (
            c: LyricChord,
            active: boolean,
          ): LyricChordStyle => ({
            className:
              active && now
                ? "lyrics-hud-chord lyrics-hud-chord-now"
                : "lyrics-hud-chord",
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
              <div className="lyrics-hud-line">
                <LyricLineText
                  lyric={line}
                  activeChord={
                    activeChord?.line === index ? activeChord.chord : null
                  }
                  chordStyle={chordStyle}
                  variant="caption"
                  layout="words"
                  singing={now && position ? position.piece : null}
                />
              </div>
            </button>
          );
        })}
      </Scroll>
    </div>
  );
}
