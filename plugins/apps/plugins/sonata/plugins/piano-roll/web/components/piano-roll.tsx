import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import {
  buildTempoIndex,
  makeKeySpeller,
  songAxis,
  unrollLoop,
  type PlayPosition,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import {
  asSonataLook,
  sonataLookConfig,
  SONATA_LOOK_STYLES,
} from "@plugins/apps/plugins/sonata/plugins/look/core";
import {
  useCursorApi,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { usePerformedScore } from "@plugins/apps/plugins/sonata/plugins/rich/plugins/swing/web";
import { useSongDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { usePlayerView } from "@plugins/apps/plugins/sonata/plugins/player/web";
import {
  LaneInsetsProvider,
  Sonata,
} from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { useInertialDrag } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/inertial-drag/web";
import {
  asPitchLayoutId,
  pitchGeometry,
  pitchKeyboardHeight,
  pitchLayoutConfig,
} from "@plugins/apps/plugins/sonata/plugins/pitch-layout/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  accidentalColor,
  useTrackColorMap,
  useHiddenTrackIds,
} from "@plugins/apps/plugins/sonata/plugins/track-mixer/web";
import { pianoRollConfig } from "../../shared/config";
import {
  authoredSecondsOf,
  buildNoteVisuals,
  type NoteVisual,
  buildProjection,
  KEYBOARD_HIGH,
  KEYBOARD_LOW,
  PX_PER_SECOND,
  snapToDevicePixel,
  SPREAD_MIN,
} from "./geometry";
import type { Application } from "pixi.js";
import { PianoRollCanvas } from "../internal/pixi/app";
import type { PianoRollScene } from "../internal/pixi/scene";
import { createFxContext } from "../internal/fx/fx-context";
import { FxHost } from "../internal/fx/fx-host";
import { ProjectionProvider } from "./projection-context";
import { OverlayHost } from "./overlay-host";
import { TransportOverlayHost } from "./transport-overlay-host";
import { TransportEdgeHost } from "./transport-edge-host";
import { FxToggle } from "./fx-toggle";
import { PitchAxisHost } from "./pitch-axis-host";

/** Props the player's `SonataPlayer.Display.Dispatch` passes to the chosen display. The
 *  playback cursor is NOT a prop — it's read from the cursor store imperatively
 *  (see `applyCursor`) so a per-frame advance never re-renders this display. */
export interface PianoRollProps {
  score: Score;
  /** Playback tempo multiplier (1 = authored). Scales the scroll rate so slowing
   *  the tempo slows the scroll instead of stretching note heights. */
  tempoScale: number;
  activeDisplayId: string;
}

/**
 * Wheel-zoom sensitivity: spread is multiplied by `exp(-deltaY * k)` per wheel
 * event, so a Ctrl+scroll UP (deltaY < 0) zooms in and DOWN zooms out — the
 * browser-zoom convention — multiplicatively (scale-free, smooth) and
 * direction-symmetric. Tuned so a ~100px notch is ≈15% and a trackpad pinch's
 * small deltas are a gentle, continuous drift.
 */
const ZOOM_WHEEL_K = 0.0015;

/** After the wheel goes quiet this long, a zoom commits to the global config and
 *  a wheel-paused playback resumes — mirroring the drag's resume-on-settle. */
const WHEEL_IDLE_MS = 180;

/** Headroom left when computing the "fit the whole song" zoom-out floor: the song
 *  fills ~92% of the lane at max zoom-out, leaving a small gap above it. */
const FIT_MARGIN = 0.92;

/**
 * Vertical gap reserved BELOW the top-right HUD cluster, on top of its measured
 * height, when computing the lane's top inset. Covers the HUD `<Pin>`'s
 * `offset="sm"` top inset plus a small breathing gap, so a screen-anchored
 * top-edge chip (the off-screen loop-boundary indicator) tucks just under the
 * HUD rather than colliding with it.
 */
const HUD_EDGE_CLEARANCE = 16; // px

/** The roll's input while the song's track views are not known: nothing drawn. */
const NO_VISUALS: NoteVisual[] = [];

/**
 * The cursor scroll layer: one `translateY` over the cursor-INVARIANT overlay
 * content, mirroring the canvas scene's `setScroll` so DOM overlays and canvas
 * notes stay glued per frame. The transform is written IMPERATIVELY by the
 * parent's cursor subscription (see `applyCursor`) via this forwarded ref — the
 * component never reads the cursor, so a per-frame advance touches one
 * `style.transform` and triggers ZERO React renders.
 *
 * Its `children` are the cursor-INVARIANT content (the projection-anchored
 * overlay host), memoized by the parent so their element identity is stable
 * between frames.
 *
 * `transform` opens a new stacking context here, so the now-line must remain a
 * sibling OUTSIDE this layer to render above it.
 */
const ScrollLayer = forwardRef<HTMLDivElement, { children: React.ReactNode }>(
  function ScrollLayer({ children }, ref) {
    return (
      // Imperatively transformed scroll layer: the parent's cursor subscription
      // writes translateY per frame (see applyCursor). Also the full-bleed
      // positioning context for the projection-anchored overlays.
      <Layer ref={ref}>{children}</Layer>
    );
  },
);

function PianoRollInner({ score, tempoScale }: PianoRollProps) {
  // Imperative per-surface cursor facade. Stable (memoized on the store), so the
  // subscription/scroll closures below never go stale and can list it in deps.
  const cursor = useCursorApi();

  // We measure the LANE (above the keyboard); its height drives the time axis.
  // `useElementSize` hands back a callback ref; we also mirror the node into
  // state so the native wheel listener below can attach to the live element
  // (the size hook owns measurement, but doesn't expose the node).
  const [sizeRef, lane] = useElementSize<HTMLDivElement>();
  const [laneEl, setLaneEl] = useState<HTMLDivElement | null>(null);
  const laneRef = useCallback(
    (node: HTMLDivElement | null) => {
      sizeRef(node);
      setLaneEl(node);
    },
    [sizeRef],
  );

  // Measure the top-right HUD cluster so screen-anchored edge indicators can
  // reserve its vertical zone — a boundary that sits under the HUD is bucketed
  // "top" and its chip tucks just below the cluster (`topInset`) instead of
  // colliding with it. `0` until the HUD has measured (no reservation yet).
  const [hudSizeRef, hudSize] = useElementSize();
  const topInset = hudSize.height > 0 ? hudSize.height + HUD_EDGE_CLEARANCE : 0;

  // Synthesia-style note-name labels (opt-in). Spelling follows the score's key
  // signature so accidentals read in-key (Eb vs D#), matching the keyboard below.
  // `spread` is the persisted GLOBAL vertical-zoom default; the live value is
  // ephemeral player view state (`usePlayerView().spread`) the toolbar wheel + pinch/
  // scroll gestures drive.
  const { showNoteNames, spread: persistedSpread } = useConfig(pianoRollConfig);
  const setConfig = useSetConfig(pianoRollConfig);

  // How the roll is DRAWN — one switch behind the lane ground, the grid ink, the
  // note pen and the key skin. Deliberately theme-independent: the roll is a
  // fixed stage (Synthesia-dark under the digital looks, cream paper under `sketch`) in
  // every theme, so the opaque note colors read the same light or dark. A look
  // is not a theme; it only picks WHICH fixed palette the surfaces are pinned to.
  const look = asSonataLook(useConfig(sonataLookConfig).look);
  const lookStyle = SONATA_LOOK_STYLES[look];
  const { spread, setSpread, setSpreadFloor } = usePlayerView();
  const {
    seekTo,
    timelineBeats,
    isPlaying,
    play,
    stop,
    loopCycle,
    loopOptions,
  } = useSession();
  const { content: songDocument } = useSongDocument();
  const scorePending = songDocument.kind === "pending";
  const scoreFailure =
    songDocument.kind === "failed" ? songDocument.failure : null;

  // Seed the live zoom from the persisted global on load (and reflect a
  // Settings-pane edit live). No loop: only an explicit commit (wheel settle /
  // pinch idle) writes the config, and never during a drag — so post-commit the
  // persisted value already equals the live one and this re-seed is a no-op.
  useLayoutEffect(() => {
    setSpread(persistedSpread);
  }, [persistedSpread, setSpread]);

  const speller = useMemo(
    () => makeKeySpeller(score.meta.key),
    [score.meta.key],
  );

  // The pitch axis, read ONCE here and threaded down. Everything that touches X
  // — the falling notes, the projection the overlays and keyboard anchor to,
  // the grid's orientation rules, and the gutter's height — comes off this one
  // plane, so a layout flip can never leave one surface on the old geometry.
  const { layout } = useConfig(pitchLayoutConfig);
  const plane = useMemo(
    () => pitchGeometry(asPitchLayoutId(layout), KEYBOARD_LOW, KEYBOARD_HIGH),
    [layout],
  );

  // The AXIS the roll draws: the song as written, or — with "show loop ahead" on
  // and a loop enabled — the song up to B followed by the loop's own repeats
  // (each opened by its rest), so past B the falling notes are what will really
  // play next. Everything below draws `axis.score` and places the cursor at its
  // AXIS beat (`axis.timeline.axisBeat`), so no renderer special-cases a loop;
  // seeks map an axis beat back to the play position shown there
  // (`axis.timeline.at`). See `unrollLoop` in score/core.
  //
  // The notes fall where they SOUND: swung like the audio (unless the user
  // turned that off in Feel), before the unroll so every repeat swings as the
  // song does. Swing moves beats, never the tempo map, so the straight cursor
  // meets each swung note at the beat the scheduler plays it.
  const performed = usePerformedScore(score);
  const axis = useMemo(
    () =>
      loopCycle && loopOptions.ahead
        ? unrollLoop(performed, loopCycle)
        : songAxis(performed),
    [performed, loopCycle, loopOptions.ahead],
  );
  const axisScore = axis.score;
  const timeline = axis.timeline;

  // Cursor-invariant projection: depends only on lane size + score, so it (and
  // every overlay anchor) stays stable while playing — only the ScrollLayer
  // moves. The canvas draws from the SAME geometry source (buildNoteVisuals
  // shares the fractional key layout and authored-seconds axis), so canvas
  // notes land pixel-exact with DOM overlays and the keyboard.
  const projection = useMemo(
    () =>
      buildProjection({
        width: lane.width,
        height: lane.height,
        plane,
        score: axisScore,
        timeline,
        tempoScale,
        spread,
      }),
    [lane.width, lane.height, plane, axisScore, timeline, tempoScale, spread],
  );

  // Tempo indices, built once per score and reused by the ScrollLayer so they
  // are not rebuilt every frame (the projection already built its own
  // internally): the AXIS tempo places the cursor and maps gestures; the song's
  // own tempo measures the song (the fit-to-lane zoom floor).
  const tempo = useMemo(() => buildTempoIndex(axisScore), [axisScore]);
  const songTempo = useMemo(() => buildTempoIndex(score), [score]);

  // --- Drag-to-scrub with momentum: the lane behaves like a movable surface. --
  // Grabbing the roll and dragging maps pointer travel 1:1 onto the scroll
  // offset, so the content follows the finger: drag DOWN advances time (future
  // notes fall toward the now-line), drag UP rewinds. A flick on release coasts
  // under exponential friction and settles. We drive the shared absolute
  // `seekTo`, the same primitive the progression-bar scrubber uses, so audio +
  // cursor stay glued. The offset's time term is
  // `seconds(cursor) * PX_PER_SECOND * tempoScale * spread`, so a 1-pixel drag
  // equals `1 / (PX_PER_SECOND * tempoScale * spread)` authored-seconds of
  // travel — hence `unitsPerPixel` (zoom in ⇒ a pixel covers less time). The
  // physics (friction, momentum) lives in the reusable inertial-drag primitive;
  // this site only maps pixels↔seconds and bridges the transport (pause on grab,
  // restore the pre-drag play state once motion ends). (`seekTo`/`isPlaying`/
  // `play`/`stop` come from the `useSession()` destructure above.)
  const hasNotes = score.notes.length > 0;
  const pxPerSecond = PX_PER_SECOND * tempoScale * spread;
  // The lane's own seconds-space view of the transport's seekable span. Both ends
  // come from `timelineBeats` — the roll never invents a bound of its own, so the
  // drag bottoms out on the empty lead-in bar exactly where a keyboard rewind
  // does. `startSeconds` is NEGATIVE for a non-empty score (the pre-roll); the
  // tempo index extrapolates it linearly, and the cursor already parks there on
  // load, so the renderer needs no special case for it.
  const [startBeat, endBeat] = timelineBeats;
  const startSeconds = tempo.beatToSeconds(startBeat);
  const endSeconds = songTempo.beatToSeconds(endBeat);
  // The drag's far bound on the AXIS: the song's end, or the last drawn loop
  // copy's end when the loop is unrolled ahead (past B the axis is the loop).
  const axisLoop = timeline.loop;
  const axisEndSeconds = tempo.beatToSeconds(
    axisLoop ? axisLoop.cycle.end + axisLoop.shifts.at(-1)! : endBeat,
  );
  const wasPlaying = useRef(false);

  // Let the user zoom OUT until the whole song fits the lane. The song's on-screen
  // pixel height is `endSeconds * PX_PER_SECOND * tempoScale * spread` (the same
  // term the scroll offset uses), so the spread that makes it exactly fill the
  // lane is `laneHeight / (endSeconds * PX_PER_SECOND * tempoScale)`. We hand a
  // touch-smaller value (FIT_MARGIN headroom) to the context as the dynamic
  // zoom-out floor; the context caps it at the default floor so short songs (which
  // already fit far above it) are unaffected. Recomputes on lane resize / tempo.
  const spreadFloor = useMemo(() => {
    if (!hasNotes || lane.height <= 0 || endSeconds <= 0) return SPREAD_MIN;
    const fit = lane.height / (endSeconds * PX_PER_SECOND * tempoScale);
    return Math.min(SPREAD_MIN, fit * FIT_MARGIN);
  }, [hasNotes, lane.height, endSeconds, tempoScale]);
  useEffect(() => {
    setSpreadFloor(spreadFloor);
  }, [spreadFloor, setSpreadFloor]);

  const { handlers, phase } = useInertialDrag({
    axis: "y",
    unitsPerPixel: 1 / pxPerSecond,
    bounds: [startSeconds, axisEndSeconds],
    origin: () => tempo.beatToSeconds(timeline.axisBeat(cursor.getPosition())),
    onScrub: (sec) => seekTo(timeline.at(tempo.secondsToBeat(sec)).beat),
    onGrab: () => {
      if (isPlaying) {
        wasPlaying.current = true;
        stop();
      }
    },
    onSettle: () => {
      if (wasPlaying.current) {
        wasPlaying.current = false;
        play();
      }
    },
  });

  // Per-track view-state: hidden tracks are dropped from the roll entirely;
  // every drawn note is tinted by its track's effective color (palette default
  // or user override). Both come from the track-mixer's per-song track views,
  // so a toggle/recolor re-derives the visuals (and only then — not per frame).
  // Until those are known no note is drawn (a hidden track must never flash in
  // for the round trip), and the lane shows the loading state below.
  const colorMap = useTrackColorMap();
  const hiddenIds = useHiddenTrackIds();

  // Authored-space note visuals — the canvas renderer's entire input. Pure and
  // CURSOR-INVARIANT: built once per (score, track view, tempoScale); resize
  // and scroll never touch it (the scene maps it to pixels with one transform).
  const visuals = useMemo(
    () =>
      colorMap.kind !== "settled" || hiddenIds.kind !== "settled"
        ? NO_VISUALS
        : buildNoteVisuals({
            score: axisScore,
            plane,
            hiddenIds: hiddenIds.value,
            colorMap: colorMap.value,
            accidentalColor,
            speller,
            tempoScale,
          }),
    [axisScore, plane, hiddenIds, colorMap, speller, tempoScale],
  );
  // A failed track-view read also fails the score gate (`scoreFailure`);
  // unsettled views otherwise read as still loading.
  const viewPending =
    scorePending || colorMap.kind !== "settled" || hiddenIds.kind !== "settled";

  // Bar markers in authored seconds (the canvas grid + bar numbers' input) —
  // the axis's own bar lines, so an unrolled loop's copies keep the loop's bar
  // numbers and each rest opens with an unnumbered line.
  const barMarkers = useMemo(
    () =>
      axis.bars.map((b) => ({
        index: b.index,
        startSec: authoredSecondsOf(tempo, tempoScale, b.startBeat),
      })),
    [axis, tempo, tempoScale],
  );

  // Live scene + app pair, published by the canvas once Pixi init settles.
  // The FX context (and host) mount off it below.
  const [pixi, setPixi] = useState<{
    scene: PianoRollScene;
    app: Application;
  } | null>(null);

  // Bumped when the canvas reports a spontaneous GPU context/device loss; used
  // as the canvas's React `key` so a loss fully remounts it — a clean teardown
  // of the dead Pixi app and a rebuild from the current props. Pixi v8 does not
  // recover from a spontaneous loss itself (see app.tsx watchContextLoss), so on
  // a long-lived tab a sleep/wake would otherwise blank the notes forever while
  // the DOM chords/keyboard kept rendering.
  const [canvasNonce, setCanvasNonce] = useState(0);
  const handleContextLost = useCallback(() => setCanvasNonce((n) => n + 1), []);

  // Set when the browser offers no GPU backend (neither WebGPU nor WebGL): the
  // canvas creates no Pixi app and the lane shows a "GPU unavailable" message
  // instead of the half-drawn roll Pixi's 2D fallback would give (letters, no
  // notes). Only a reload / browser restart can change the answer — Pixi caches
  // its WebGL probe per page — so there is no in-page way back to false.
  const [gpuUnavailable, setGpuUnavailable] = useState(false);
  const handleGpuUnavailable = useCallback(() => setGpuUnavailable(true), []);

  // Latest-geometry refs for the FX context. The context is identity-stable
  // (memoized on the pixi pair only) so effects never remount on resize —
  // instead its accessors read these refs, which mirror the freshest
  // projection/lane values every render. Closing over `projection` directly
  // would hand effects a stale snapshot after the first resize.
  const projectionRef = useLatestRef(projection);
  const laneSizeRef = useLatestRef(lane);
  const timelineRef = useLatestRef(timeline);

  // FX bridge — one per scene. See fx-context.ts for the accessor/budget design.
  const fx = useMemo(
    () =>
      pixi
        ? // eslint-disable-next-line react-hooks/refs -- the refs are captured into deferred accessor closures (getProjection/getLaneSize), NEVER read during this render; they're read later when an FX effect calls the accessor, so the context stays identity-stable across resize.
          createFxContext({
            scene: pixi.scene,
            app: pixi.app,
            getProjection: () => projectionRef.current,
            getLaneSize: () => laneSizeRef.current,
            // The shared playback cursor, on the AXIS the notes are drawn on —
            // the clock note-anchored effects read so their geometry stays a
            // pure function of the cursor (glued to the notes on pause/scrub)
            // instead of integrating wall-clock.
            getPlaybackBeats: () =>
              timelineRef.current.axisBeat(cursor.getPosition()),
          })
        : null,
    [pixi, cursor],
  );

  // --- Imperative cursor path. The playhead advances ~60fps via the cursor
  // store; routing it through React would re-render this whole display every
  // frame. Instead a single subscription pushes the cursor straight to the Pixi
  // scene (`setScroll`) and the DOM scroll layer's `transform`, reading the
  // latest geometry from refs — so a frame is two imperative writes and ZERO
  // React renders. This component re-renders only on real input changes (score,
  // lane size, tempo, track view).
  const scrollLayerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useLatestRef(pixi?.scene ?? null);
  const tempoRef = useLatestRef(tempo);
  const tempoScaleRef = useLatestRef(tempoScale);
  // Live zoom, read imperatively by the per-frame DOM offset and the wheel
  // handler (which must not re-attach on every zoom tick).
  const spreadRef = useLatestRef(spread);
  // Play state read imperatively by the wheel-seek pause/resume bridge.
  const isPlayingRef = useLatestRef(isPlaying);

  const applyCursor = useCallback((position: PlayPosition, seek = false) => {
    const scene = sceneRef.current;
    const tempo = tempoRef.current;
    const ts = tempoScaleRef.current;
    // Where the cursor sits on the AXIS the notes are drawn on (its score beat
    // unless the loop is unrolled ahead; see `axis` above).
    const beat = timelineRef.current.axisBeat(position);
    // A seek/jump (scrub, seek, score reset) must re-anchor the onset tracker
    // instead of advancing through every note between the old and new position
    // — navigation must not spray note-strike FX. `reset()` defers the re-anchor
    // to the setScroll just below, which carries the post-seek cursor.
    if (seek) scene?.reset();
    // Canvas: one O(1) container move in authored seconds.
    scene?.setScroll(authoredSecondsOf(tempo, ts, beat), beat);
    // DOM overlays: the same lane-bottom offset the scene applies to its scroll
    // root, so overlays and canvas notes stay glued. `PX_PER_SECOND * ts *
    // spread` mirrors the geometry's effective pixels-per-second, so a slower
    // tempo scrolls slower and a higher zoom spreads the overlays in lockstep.
    const el = scrollLayerRef.current;
    if (el) {
      const offset =
        laneSizeRef.current.height +
        tempo.beatToSeconds(beat) * PX_PER_SECOND * ts * spreadRef.current;
      // Snapped exactly as the scene snaps its scroll root, so the two stay glued.
      el.style.transform = `translateY(${snapToDevicePixel(offset, window.devicePixelRatio)}px)`;
    }
  }, []);

  // Drive the imperative path on every cursor change — no React render. The
  // store tells us whether the change was a seek so we re-anchor onsets.
  useEffect(
    () => cursor.subscribe((seek) => applyCursor(cursor.getPosition(), seek)),
    [applyCursor, cursor],
  );

  // --- Wheel gestures on the lane: plain scroll SEEKS, pinch / Ctrl+scroll
  // ZOOMS. A native non-passive listener (React's onWheel is passive and can't
  // preventDefault) so the page never scrolls under the gesture. Live zoom +
  // play-state are read from refs so a 60fps gesture never re-attaches.
  useEffect(() => {
    const el = laneEl;
    if (!el || !hasNotes) return;

    let idle: number | null = null;
    let pausedByWheel = false;
    let zoomed = false;
    const settle = () => {
      idle = null;
      // Commit the zoom to the global default and resume any wheel-paused play.
      // A sub-default fit-zoom is a transient per-song view, NOT a saved note-size
      // preference, so it is never persisted globally (that would shrink the next
      // song too) — only in-range zooms write back.
      if (zoomed) {
        zoomed = false;
        if (spreadRef.current >= SPREAD_MIN)
          setConfig("spread", spreadRef.current);
      }
      if (pausedByWheel) {
        pausedByWheel = false;
        play();
      }
    };
    const bumpIdle = () => {
      if (idle !== null) window.clearTimeout(idle);
      idle = window.setTimeout(settle, WHEEL_IDLE_MS);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) {
        // Pinch / Ctrl+scroll → multiplicative zoom (context clamps the range).
        zoomed = true;
        setSpread(spreadRef.current * Math.exp(-e.deltaY * ZOOM_WHEEL_K));
      } else {
        // Plain scroll → seek. Map wheel pixels to authored-seconds with the
        // SAME px/sec the drag uses (down/forward), then drive shared `seekTo`.
        // Deliberately UNCLAMPED: `seekTo` owns the timeline bound, so an
        // overscrolling wheel simply parks on the lead-in origin / the end — the
        // same stops the keyboard rewind reaches. (A local clamp here is what used
        // to floor the wheel on beat 0, i.e. the first note.)
        if (isPlayingRef.current && !pausedByWheel) {
          pausedByWheel = true;
          stop();
        }
        const perPx = 1 / (PX_PER_SECOND * tempoScale * spreadRef.current);
        const cur = tempo.beatToSeconds(
          timeline.axisBeat(cursor.getPosition()),
        );
        seekTo(timeline.at(tempo.secondsToBeat(cur + e.deltaY * perPx)).beat);
      }
      bumpIdle();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (idle !== null) window.clearTimeout(idle);
    };
  }, [
    laneEl,
    hasNotes,
    cursor,
    tempo,
    timeline,
    tempoScale,
    seekTo,
    setSpread,
    setConfig,
    play,
    stop,
  ]);

  // Re-sync after any reactive change (scene ready, resize, tempo, zoom) and on
  // mount, so the view lands correctly even while paused (no cursor tick fires
  // then). A spread change resizes the content in place, so the DOM offset must
  // be re-applied here in lockstep with the scene's own rescale (app.tsx).
  // Layout effect so the transform is applied before paint (no flash).
  useLayoutEffect(() => {
    applyCursor(cursor.getPosition());
  }, [
    applyCursor,
    cursor,
    pixi,
    lane.height,
    tempo,
    timeline,
    tempoScale,
    spread,
  ]);

  // The cursor-invariant DOM content, MEMOIZED on its real inputs. The overlay
  // subtree's element identity stays stable between frames (this component no
  // longer re-renders per frame at all — the cursor drives the imperative path
  // above), so React never reconciles it during playback.
  const content = useMemo(
    () => (
      <ProjectionProvider projection={projection}>
        <OverlayHost score={axisScore} />
        <TransportOverlayHost />
      </ProjectionProvider>
    ),
    [projection, axisScore],
  );

  return (
    <Stack gap="none" className="h-full w-full bg-background">
      {/* The note lane. Notes, grid, and labels render on the Pixi canvas in
          cursor-invariant authored space; DOM keeps the overlays, now-line,
          HUD, and keyboard. Pitch is the fixed full keyboard across the width,
          so canvas notes align column-for-key with the keyboard below. */}
      <Clip
        fill
        ref={laneRef}
        {...(hasNotes ? handlers : null)}
        // The look's ground, plus its optional paper grain as a background-image
        // on the SAME div — over the color, under the transparent canvas. No
        // overlay element and no blend mode: a multiply layer would have to sit
        // above the canvas to reach the lane, and would dull the notes with it.
        style={{
          backgroundColor: lookStyle.laneBg,
          backgroundImage: lookStyle.laneGrain ?? undefined,
        }}
        className={cn(
          "relative touch-none select-none",
          hasNotes
            ? phase === "idle"
              ? "cursor-grab"
              : "cursor-grabbing"
            : null,
        )}
      >
        {/* Publish the HUD-reserved top inset to the lane subtree, so BOTH the
            scroll-synced loop band (TransportOverlayHost → LoopRollRegion) and
            the screen-anchored edge indicator (TransportEdgeHost) bucket a
            boundary sitting under the HUD as "top" and clear the cluster. */}
        <LaneInsetsProvider insets={{ top: topInset }}>
          {/* The GPU note lane: grid, falling notes, and labels — under every
              DOM layer (transparent canvas; the lane bg shows through). */}
          <PianoRollCanvas
            key={canvasNonce}
            width={lane.width}
            height={lane.height}
            visuals={visuals}
            bars={barMarkers}
            pitchLines={plane.guides}
            scoreNotes={axisScore.notes}
            showLabels={showNoteNames}
            tempoScale={tempoScale}
            spread={spread}
            look={look}
            onSceneReady={setPixi}
            onContextLost={handleContextLost}
            onGpuUnavailable={handleGpuUnavailable}
          />

          {/* Headless FX wiring — every PianoRollFx contribution, config-gated
              and error-isolated. Renders no DOM; effects paint into the scene's
              fx layers via the context. */}
          {fx ? <FxHost fx={fx} /> : null}

          <ScrollLayer ref={scrollLayerRef}>{content}</ScrollLayer>

          {/* Playback now-line: where falling notes land on the keyboard. Screen-
              anchored, so it sits OUTSIDE the scroll layer (and above it). */}
          <Placed
            decorative
            layer="raised"
            x={{ start: 0, size: lane.width }}
            y={{ start: lane.height, size: 2 }}
            className="bg-primary"
          />

          {/* Screen-anchored transport-edge indicators (the off-screen A–B loop
              boundary arrow chips). Sits OUTSIDE the scroll layer so it stays
              pinned to the lane edges; takes the projection as a prop. */}
          <TransportEdgeHost projection={projection} />

          {/* HUD: screen-anchored heads-up chips (current key, …) pinned to the
              lane's top-right corner — above the scroll layer and now-line, clear
              of the chord overlay that hugs the left edge. Contributors read the
              session cursor via useSession(); collection-consumer clean (renders the
              generic Sonata.Hud slot, never naming a contributor). The ref feeds
              `topInset` so an edge chip tucks just below this cluster. */}
          <Pin
            to="top-right"
            offset="sm"
            layer="float"
            decorative
            ref={hudSizeRef}
          >
            <Stack gap="xs" align="end">
              <Sonata.Hud.Render>
                {(h) => <h.component key={h.id} />}
              </Sonata.Hud.Render>
              {/* Host-owned FX popover — piano-roll-specific, so it stays
                  manually mounted with the HUD chips and re-enables its own
                  pointer events (the cluster is pointer-events-none). The
                  shared display-options "View" chip is contributed to
                  Sonata.Hud above by the view-options plugin. */}
              <FxToggle />
            </Stack>
          </Pin>

          {/* No GPU: nothing can draw the notes, so say so plainly (it takes
              the empty-score slot — one centred message at most). */}
          {gpuUnavailable ? (
            <Layer decorative>
              <Center className="h-full w-full">
                <Stack gap="xs" align="center" className="max-w-md text-center">
                  <Text as="span" variant="body">
                    Can't draw notes: the browser has no GPU available.
                  </Text>
                  <Text
                    as="span"
                    variant="body"
                    className="text-muted-foreground"
                  >
                    Graphics acceleration is off in this browser, often after a
                    GPU crash. Restart the browser; chrome://gpu shows the
                    details.
                  </Text>
                </Stack>
              </Center>
            </Layer>
          ) : scoreFailure !== null ? (
            /* A setting could not be read: not "no notes", not a spinner. */
            <Layer>
              <Center className="h-full w-full">
                <ResourceErrorInline
                  variant="block"
                  subject="the song's settings"
                  error={scoreFailure.error}
                  refetch={scoreFailure.refetch}
                />
              </Center>
            </Layer>
          ) : viewPending ? (
            /* The song's settings are still loading: not "no notes". */
            <Layer decorative>
              <Center className="h-full w-full">
                <Loading />
              </Center>
            </Layer>
          ) : score.notes.length === 0 ? (
            /* Empty-score affordance. */
            // Full-bleed layer over the lane (sibling of the canvas/scroll
            // layers), centering the empty-state message.
            <Layer decorative>
              <Center className="h-full w-full">
                <Text
                  as="span"
                  variant="body"
                  className="text-muted-foreground"
                >
                  No notes to display. Load a source to see the piano roll.
                </Text>
              </Center>
            </Layer>
          ) : null}
        </LaneInsetsProvider>
      </Clip>

      {/* Pitch-axis gutter: the piano keyboard (and any future pitch-axis
          decorations) contributed via `Sonata.PitchAxis`. */}
      <div
        // eslint-disable-next-line layout/no-adhoc-layout -- rigid footer edge of the column (fixed keyboard height); Stack has no per-child shrink-0 role and the body is a canvas Clip, not a Scroll, so Column doesn't fit
        className="relative shrink-0 border-t border-border"
        style={{ height: pitchKeyboardHeight(plane.layout, "keybed") }}
      >
        <PitchAxisHost projection={projection} />
      </div>
    </Stack>
  );
}

/**
 * The piano-roll Display. Renders notes Synthesia-style on a time (vertical) ×
 * pitch (horizontal full-keyboard) grid that falls toward a piano keyboard at
 * the bottom — notes/grid/labels on a PixiJS canvas (WebGPU-first, WebGL
 * fallback, never Pixi's 2D canvas renderer — a "GPU unavailable" message
 * instead), chrome and overlays in DOM. Publishes a `Projection` (both
 * capabilities) and hosts capability-compatible overlays (over the lane) and
 * pitch-axis decorations (in the gutter).
 */
export function PianoRoll(props: PianoRollProps) {
  return <PianoRollInner {...props} />;
}
