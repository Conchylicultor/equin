import {
  Placed,
  pct,
  placedClasses,
  placedStyle,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import {
  useCursorApi,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  scoreEndBeat,
  buildTempoIndex,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { SonataProgress } from "../slots";
import {
  RAIL_HEIGHT,
  RAIL_HOT,
  RAIL_REST,
  RAIL_THICKNESS_VAR,
  ZONE_HEIGHT,
} from "../rail-geometry";
import { railSegments, segmentAt, segmentFill, snapBeat } from "../lane-layout";
import { formatTime } from "./format-time";
import { createHoverStore, HoverPreview } from "./hover-preview";
import { LabelLane } from "./label-lane";

/** Gap between neighbouring rail segments (chapters), in px. */
const SEGMENT_GAP = 3;

/** The played part of the rail: from the accent's violet side into the accent. */
const PLAYED_FILL =
  "linear-gradient(90deg, color-mix(in oklab, var(--primary) 60%, var(--chord-6)), var(--primary))";

/** The playhead's white knob, ringed and lit by the accent. */
const PLAYHEAD_GLOW =
  "0 0 0 4px color-mix(in oklab, var(--primary) 35%, transparent), 0 0 16px var(--primary)";

/**
 * The Sonata Transport progression bar: `[elapsed / total][slider]`, the
 * growing middle of the player's transport strip. The slider is a thin rail
 * over the whole song `[0, endBeat]` — split into one rounded segment per
 * chapter (`SonataProgress.Chapters`), thickening on hover/drag — with the
 * label lane (`SonataProgress.Label`) under it and a hover preview
 * (`SonataProgress.Describe`) above. It reads the shared cursor and drives the
 * absolute `seekTo` primitive on click/drag, and hosts `SonataProgress.Marker`
 * as a pointer-transparent overlay so contributed markers (bar notches, key
 * lines, the loop) layer on without intercepting seeks. It never names a
 * contributor.
 *
 * The playhead, the segment fills, the elapsed-time readout, and the ARIA value
 * all change every frame during playback. Rather than re-render this whole
 * subtree ~60×/sec (a per-frame React commit that the render-loop detector
 * flags as a `subtree-cascade` of wasted DOM thrash), it subscribes to the
 * cursor IMPERATIVELY — exactly like the piano-roll's `applyCursor` — and
 * paints via refs with ZERO React renders:
 *  - fills / playhead move via `transform` (`scaleX` / `translateX`), which the
 *    GPU composites and the render-loop detector skips as animation-driven;
 *  - the time readout is written through the text node's data (a
 *    characterData write, which the detector's MutationObserver does not watch);
 *  - `aria-valuenow` / `aria-valuetext` are updated only when the rounded
 *    value actually changes.
 *
 * Hover is pointer-driven, not per-frame, but it stays off the bar's render
 * path too: the ghost line, the hot segment and the rail thickness are written
 * imperatively from the pointer handlers, and only the small preview box
 * re-renders (it reads a hover store of its own).
 */
export function ProgressBar() {
  const { score, seekTo } = useSession();
  // Imperative cursor facade — read the live beat in the subscription, never a
  // per-frame React render (see the component doc-comment).
  const cursor = useCursorApi();
  const markers = SonataProgress.Marker.useContributions();
  const chapterSources = SonataProgress.Chapters.useContributions();
  const describes = SonataProgress.Describe.useContributions();

  const endBeat = scoreEndBeat(score);
  const ready = endBeat > 0;

  // beat → elapsed wall-clock seconds. The `score` from useSession() already has
  // the playback speed (tempoScale) folded into its tempo map, so this readout
  // is a real stopwatch: at 50% speed the elapsed/total times stretch to match.
  const tempo = useMemo(() => buildTempoIndex(score), [score]);

  // beat → [0,1] along the track; the single projector shared by the playhead,
  // the fills, the label lane, and every contributed marker.
  const beatToFraction = useCallback(
    (b: number) => (endBeat > 0 ? Math.max(0, Math.min(1, b / endBeat)) : 0),
    [endBeat],
  );

  // The rail's segments: the first contributor with chapters wins; none → one
  // segment over the whole song.
  const segments = useMemo(() => {
    for (const c of chapterSources) {
      const chapters = c.chapters(score);
      if (chapters.length > 0) return railSegments(chapters, endBeat);
    }
    return railSegments([], endBeat);
  }, [chapterSources, score, endBeat]);

  // Every beat the hover preview may snap onto (key changes, …), per score.
  const snapBeats = useMemo(
    () =>
      describes.flatMap((d) => (d.snapBeats ? [...d.snapBeats(score)] : [])),
    [describes, score],
  );

  // Imperative paint targets — the cursor subscription and the pointer
  // handlers write these directly.
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const fillRefs = useRef<(HTMLElement | null)[]>([]);
  const segmentRefs = useRef<(HTMLElement | null)[]>([]);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const hotSegment = useRef(-1);
  const hover = useMemo(() => createHoverStore(), []);
  // New segments are new elements (none marked hot): forget the old index.
  useEffect(() => {
    hotSegment.current = -1;
  }, [segments]);

  const totalText = useMemo(
    () => (ready ? formatTime(tempo.beatToSeconds(endBeat)) : "—"),
    [ready, tempo, endBeat],
  );

  // Subscribe to the cursor and paint the playhead, fills, readout, and ARIA
  // value imperatively — no React render per frame. Re-armed whenever the
  // score-derived projectors change (new song / tempo / chapters). The store
  // reports seeks, but a scrubber paints identically for a smooth advance or a
  // jump.
  useEffect(() => {
    const slider = sliderRef.current;
    let lastAria = NaN;
    const paint = () => {
      const beat = cursor.getBeat();
      const fraction = beatToFraction(beat);
      segments.forEach((seg, i) => {
        const fill = fillRefs.current[i];
        if (fill) fill.style.transform = `scaleX(${segmentFill(seg, beat)})`;
      });
      if (handleRef.current) {
        handleRef.current.style.transform = `translateX(${fraction * 100}%)`;
      }
      if (timeRef.current) {
        const text = ready ? formatTime(tempo.beatToSeconds(beat)) : "—";
        // Update the EXISTING text node's data (a characterData write the
        // render-loop detector does not observe) rather than `textContent`,
        // which swaps the node and would register a per-frame childList
        // mutation — the aggregate cascade tier counts those at a 6/s floor.
        const node = timeRef.current.firstChild;
        if (node && node.nodeType === Node.TEXT_NODE) {
          node.nodeValue = text;
        } else {
          timeRef.current.textContent = text;
        }
      }
      // The ARIA value only needs to track the position coarsely for assistive
      // tech; updating it every frame is a per-frame attribute mutation for no
      // benefit, so write it only when its rounded value changes.
      if (slider) {
        // Clamp to the slider's declared domain `[0, endBeat]` — the lead-in
        // pre-roll sits at negative beats where the handle visually pins to the
        // left edge (see `beatToFraction`), so the ARIA value tracks the shown
        // position and never drops below `aria-valuemin={0}`.
        const rounded = Math.round(Math.max(0, Math.min(endBeat, beat)));
        if (rounded !== lastAria) {
          lastAria = rounded;
          slider.setAttribute("aria-valuenow", String(rounded));
          slider.setAttribute(
            "aria-valuetext",
            ready
              ? `${formatTime(tempo.beatToSeconds(rounded))} of ${totalText}`
              : "",
          );
        }
      }
    };
    paint();
    return cursor.subscribe(paint);
  }, [cursor, beatToFraction, tempo, ready, totalText, endBeat, segments]);

  // Pointer x → beat along the track (unsnapped). The one place the math lives.
  const beatAtPointer = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const f = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
      return Math.max(0, Math.min(1, f)) * endBeat;
    },
    [endBeat],
  );

  // The rail's thickness: a custom property every on-rail mark sizes against
  // (`RAIL_HEIGHT`), written here so hover/drag thicken the whole rail with no
  // React state and no per-marker code.
  const setRailHot = useCallback((hot: boolean) => {
    sliderRef.current?.style.setProperty(
      RAIL_THICKNESS_VAR,
      hot ? RAIL_HOT : RAIL_REST,
    );
  }, []);

  // Light up the segment under the pointer (a data attribute its classes read).
  const setHotSegment = useCallback((i: number) => {
    if (hotSegment.current === i) return;
    segmentRefs.current[hotSegment.current]?.removeAttribute("data-hot");
    segmentRefs.current[i]?.setAttribute("data-hot", "");
    hotSegment.current = i;
  }, []);

  // Track the pointer for the hover affordances: ghost line, hot segment and
  // the preview. While hovering, the position snaps onto a contributor's snap
  // beat; while dragging it shows exactly where the seek lands.
  const trackHover = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, dragging: boolean) => {
      const raw = beatAtPointer(e);
      const width = e.currentTarget.getBoundingClientRect().width;
      const beat = dragging
        ? raw
        : snapBeat(raw, snapBeats, width / endBeat).beat;
      const fraction = beatToFraction(beat);
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translateX(${fraction * 100}%)`;
      }
      setHotSegment(segmentAt(segments, beat));
      hover.set({ beat, fraction });
    },
    [
      beatAtPointer,
      snapBeats,
      endBeat,
      beatToFraction,
      setHotSegment,
      segments,
      hover,
    ],
  );

  const endHover = useCallback(() => {
    setRailHot(false);
    setHotSegment(-1);
    hover.set(null);
  }, [setRailHot, setHotSegment, hover]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Capture so the drag keeps tracking even if the pointer leaves the bar.
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.setAttribute("data-dragging", "");
      setRailHot(true);
      seekTo(beatAtPointer(e));
      trackHover(e, true);
    },
    [beatAtPointer, seekTo, setRailHot, trackHover],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Primary button held → continuous drag-scrub — but only for a drag the
      // track itself started (it captured the pointer on press). A marker that
      // runs its own drag (the loop handles) captures the pointer instead, and
      // its moves still bubble up here; without this check they would drag the
      // playhead along with the handle.
      const dragging =
        (e.buttons & 1) !== 0 && e.currentTarget.hasPointerCapture(e.pointerId);
      if (dragging) seekTo(beatAtPointer(e));
      trackHover(e, dragging);
    },
    [beatAtPointer, seekTo, trackHover],
  );

  const onPointerEnter = useCallback(() => setRailHot(true), [setRailHot]);

  // A hovered label-lane group lights up the rail segment it sits on.
  const onLabelHover = useCallback(
    (beat: number | null) =>
      setHotSegment(beat === null ? -1 : segmentAt(segments, beat)),
    [setHotSegment, segments],
  );

  const onPointerLeave = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // A drag the track owns keeps its hover state until the release.
      if (!e.currentTarget.hasAttribute("data-dragging")) endHover();
    },
    [endHover],
  );

  const onLostPointerCapture = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.currentTarget.removeAttribute("data-dragging");
      // Released off the bar → the hover is over too.
      if (!e.currentTarget.matches(":hover")) endHover();
    },
    [endHover],
  );

  // The growing cell of the transport strip: `PlayerTransport` owns the row
  // (its rule, inset and alignment), this bar takes the slack between its
  // neighbours (play / pause, the loop toggle) — the contribution declares
  // `fill`, so the slot's cell grows and this box fills it.
  return (
    <Stack direction="row" align="center" gap="md" className={fillClasses("x")}>
      {/* Elapsed time (m:ss.s), written through the text node by the cursor
          subscription (a characterData write the render-loop detector does
          not observe), so it updates every frame without a React commit. */}
      <Text
        variant="caption"
        tone="muted"
        className={cn(rigidClass(), "min-w-21 tabular-nums")}
      >
        <span ref={timeRef} className="font-bold text-foreground">
          {ready ? "0:00.0" : "—"}
        </span>
        {" / "}
        {totalText}
      </Text>

      {/* The slider column: the rail zone and the label lane under it — the
          span the hover preview floats beside (below it, flipping above). */}
      <div ref={columnRef} className={cn(fillClasses("x"), "relative")}>
        {/* Interactive track — exactly the rail zone. Its height is the
            positioning context every marker and the playhead resolve against
            (`RAIL_BAND_Y` is 50% of THIS box). Named group `scrub`, so the
            ghost line reads hover/drag in CSS. */}
        <div
          ref={sliderRef}
          role="slider"
          aria-label="Song position"
          aria-valuemin={0}
          aria-valuemax={ready ? endBeat : 0}
          aria-valuenow={0}
          onPointerDown={ready ? onPointerDown : undefined}
          onPointerMove={ready ? onPointerMove : undefined}
          onPointerEnter={ready ? onPointerEnter : undefined}
          onPointerLeave={ready ? onPointerLeave : undefined}
          onLostPointerCapture={ready ? onLostPointerCapture : undefined}
          className={cn(
            "group/scrub relative touch-none select-none",
            ready && "cursor-pointer",
          )}
          style={{ height: ZONE_HEIGHT }}
        >
          {/* Layering (bottom → top): the rail segments + fills are the
            background bar, the marker layer is the annotation stratum painted
            *on* the bar, then the ghost line, and the playhead handle is the
            foreground knob. This z-order (rail → markers → handle) is why bar
            notches live in the marker layer rather than overhang the rail:
            they read as cuts in the bar's surface, with the handle still
            sitting readably on top. */}

          {/* The rail: one rounded pill per chapter, `SEGMENT_GAP` apart (no
            gap at the outer ends), each centered on the zone's mid-line at the
            rail's current thickness — plus 2px each side while it is the
            segment under the pointer (`data-hot`, set by the pointer
            handlers). Each segment clips its own fill: a full-bleed layer
            scaled from the left by the cursor subscription, so the playback
            advance composites on the GPU and emits no counted DOM mutation.
            `<Clip>` is the sanctioned clipping box; placed through the coords
            helpers since it is not a `<Placed>` itself. */}
          {segments.map((seg, i) => {
            const padStart = seg.gapBefore ? SEGMENT_GAP / 2 : 0;
            const padEnd = seg.gapAfter ? SEGMENT_GAP / 2 : 0;
            return (
              <Clip
                key={`${seg.start}-${seg.end}`}
                ref={(el: HTMLElement | null) => {
                  segmentRefs.current[i] = el;
                }}
                className={cn(
                  placedClasses(),
                  "rounded-full bg-foreground/12 transition-[height] duration-150 data-[hot]:[--segment-grow:4px]",
                )}
                style={placedStyle(
                  {
                    start: `calc(${pct(seg.from)} + ${padStart}px)`,
                    size: `calc(${pct(seg.to - seg.from)} - ${padStart + padEnd}px)`,
                  },
                  {
                    center: "50%",
                    size: `calc(${RAIL_HEIGHT} + var(--segment-grow, 0px))`,
                  },
                )}
              >
                <Layer
                  ref={(el: HTMLElement | null) => {
                    fillRefs.current[i] = el;
                  }}
                  className="origin-left"
                  // The played part warms from the accent's violet side into
                  // the accent itself.
                  style={{ transform: "scaleX(0)", background: PLAYED_FILL }}
                />
              </Clip>
            );
          })}

          {/* Marker layer — spans the whole zone so markers can stand proud of
            the rail (`railBand(outset)`). Painted above the rail so on-rail
            marks (bar notches) are visible; pointer-transparent so clicks fall
            through to the seek track; each marker anchors itself horizontally
            via `beatToFraction`. */}
          <Layer decorative>
            {markers.map((m) =>
              renderIsolated(
                SonataProgress.Marker,
                m as unknown as Contribution,
                {
                  score,
                  beatToFraction,
                },
              ),
            )}
          </Layer>

          {/* Ghost line at the hover position: a full-bleed carrier translated
            by the pointer handlers (like the playhead), shown on hover and
            hidden while dragging (the playhead itself follows the drag). Toggled
            by visibility, not opacity: it is click-through either way. */}
          <Layer
            ref={ghostRef}
            decorative
            className="invisible group-hover/scrub:visible group-data-[dragging]/scrub:invisible"
          >
            <Placed
              x={{ start: 0, size: 1 }}
              y={{ center: "50%", size: "calc(100% - 4px)" }}
              className="bg-foreground/35"
            />
          </Layer>

          {/* Playhead handle — foreground, above rail, markers and ghost. A
            full-bleed layer driven by `transform: translateX(<fraction>%)` from
            the cursor subscription (% is relative to the full-width layer, so it
            tracks the track), with the knob pinned at the layer's left edge and
            self-centered. transform keeps the advance off the React/DOM-mutation
            path. */}
          {ready ? (
            <Layer
              ref={handleRef}
              decorative
              style={{ transform: "translateX(0)" }}
            >
              {/* The knob sits at the carrier's left edge, self-centered on both
                axes; the carrier's own translateX is what places it along the
                track (`translate` and `transform` compose). */}
              <Placed
                x={{ start: 0, shift: "-50%" }}
                y={{ center: "50%" }}
                className="size-4 rounded-full bg-white"
                style={{ boxShadow: PLAYHEAD_GLOW }}
              />
            </Layer>
          ) : null}
        </div>

        <LabelLane
          score={score}
          beatToFraction={beatToFraction}
          endBeat={endBeat}
          onHoverBeat={onLabelHover}
        />

        {ready ? (
          <HoverPreview
            store={hover}
            score={score}
            tempo={tempo}
            trackRef={sliderRef}
            columnRef={columnRef}
          />
        ) : null}
      </div>
    </Stack>
  );
}
