/**
 * The piano-roll Pixi scene — the imperative handle the React layer drives.
 * One instance per mounted canvas; everything visual hangs off `app.stage`:
 *
 *   stage
 *   ├─ pitchLines       screen space — fixed pitch grid, redrawn on resize only
 *   ├─ fxBelow          FX layer (Phase 3) painting UNDER the notes
 *   ├─ scrollRoot       y = laneHeight + scrollSec × PX_PER_SECOND (per frame)
 *   │   ├─ contentScaled  scale = (notesWidth, PX_PER_SECOND) — authored space
 *   │   │   ├─ barLines     content space, built once per score
 *   │   │   └─ noteMesh     content space, built once per score
 *   │   └─ pixelScroll     no scale — text stays undistorted
 *   │       ├─ barNumbers
 *   │       └─ noteLabels
 *   └─ fxAbove          FX layer (Phase 3) painting OVER the notes
 *
 * COORDINATE CONVENTIONS (the load-bearing part):
 *  - Content is authored with y = -seconds (and x in 0..1 key-fractions),
 *    matching `geometry.ts`'s content-space `beatToY` — so `contentScaled`
 *    keeps a POSITIVE scale and the scroll formula is byte-identical to the
 *    DOM `ScrollLayer`: offset = laneHeight + authoredSec × PX_PER_SECOND.
 *    Resize touches one scale + two uniforms; scroll touches one container y.
 *  - `pixelScroll` shares the same translateY but no scale; its children are
 *    positioned at y = -seconds × PX_PER_SECOND pixels directly.
 *
 * ONSET-TRACKER BRIDGE (documented decision): the scene scrolls in AUTHORED
 * SECONDS but onsets are naturally beat events, and the shared
 * `createOnsetTracker` (with its seek-vs-frame heuristics) works in BEATS. The
 * cleanest bridge is for `setScroll` to take BOTH values — the React layer
 * already has them on the same frame — and for `setScore` to carry the
 * beat-domain `scoreNotes` alongside the visuals. The scene owns the tracker
 * and fans detected onsets out as fully-resolved {@link FxNoteEvent}s (screen
 * px + resolved color), because only the scene knows the lane size and color
 * cache. Notes on hidden tracks have no visual and are skipped — hidden tracks
 * should not spark FX.
 */
import { Container, type Application } from "pixi.js";
import type { Note } from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  SONATA_LOOK_STYLES,
  type SonataLook,
} from "@plugins/apps/plugins/sonata/plugins/look/core";
import type { PitchGuide } from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { FxNoteEvent } from "../../slots";
import {
  PX_PER_SECOND,
  snapToDevicePixel,
  type NoteVisual,
} from "../../components/geometry";
import { createOnsetTracker, type OnsetTracker } from "../fx/onset-tracker";
import { resolveCssColor } from "./css-color";
import { createGrid, type BarMarker } from "./grid";
import { createLabelLayer } from "./labels";
import { createNoteMesh } from "./note-mesh";
import { createRenderScheduler } from "./render-scheduler";

export interface PianoRollSceneInput {
  notes: NoteVisual[];
  bars: BarMarker[];
  /** Pitch-axis boundary lines (B–C octave splits + E–F mid-octave splits). */
  pitchLines: readonly PitchGuide[];
  /** Beat-domain notes feeding the onset tracker (see the bridge note above). */
  scoreNotes: Note[];
  /** Playback tempo multiplier — wall-clock duration = authored / tempoScale. */
  tempoScale: number;
}

export interface PianoRollScene {
  setScore(input: PianoRollSceneInput): void;
  /** `width` is the canvas; `notesWidth` the keys' part of it from the left
   *  edge — narrower when the roll bleeds under a host's chrome. Notes, pitch
   *  rules and labels lay out across `notesWidth`; the bar rules span `width`. */
  resize(width: number, notesWidth: number, height: number, dpr: number): void;
  /** Per frame: scroll offset (authored sec) + cursor (beats) for onsets. */
  setScroll(authoredSec: number, cursorBeat: number): void;
  /** Set the vertical zoom (1 = base). Rescales the content layer, note SDF
   *  uniform, bar lines, and labels in place — geometry buffers are NOT rebuilt
   *  (notes are stored in authored seconds), so this is a cheap O(1)+O(bars)
   *  animatable knob. Re-applies the scroll so the cursor stays glued. */
  setSpread(spread: number): void;
  /** Seek/jump: re-anchor the onset tracker and tell FX to drop in-flight state. */
  reset(): void;
  setShowLabels(on: boolean): void;
  /**
   * Switch the LOOK (how the roll is drawn: pen, grid ink, text face). Fans the
   * look's palette out to the three layers, each of which STORES its own slice —
   * so a later theme flip (`refreshColors`) re-resolves the look's expressions
   * instead of clobbering them.
   *
   * Never rebuild the scene to change look: `createPianoRollScene` runs once per
   * Pixi mount, and the FX plugins hold direct references to `fxLayers` through
   * a context memoized on the pixi pair — a rebuilt scene would leave every
   * mounted effect parenting into destroyed containers. Nothing here touches
   * note buffers, note colours, the onset tracker, the label pool identities, or
   * the colour cache.
   */
  setLook(look: SonataLook): void;
  /** Theme flip: re-resolve every CSS color expression and rewrite tints. */
  refreshColors(): void;
  /** Mount points for FX plugins (see slots.ts — FxContext.layers). */
  fxLayers: { belowNotes: Container; aboveNotes: Container };
  onNoteOn(cb: (e: FxNoteEvent) => void): () => void;
  onReset(cb: () => void): () => void;
  /**
   * Render-on-demand (see render-scheduler.ts). Every mutator above already
   * requests a frame; `onFrame` registers an FX per-frame updater that returns
   * whether it is still animating, and `halt` permanently stops rendering
   * (GPU context loss).
   */
  onFrame(update: (dtSec: number) => boolean): () => void;
  halt(): void;
  destroy(): void;
}

export function createPianoRollScene(app: Application): PianoRollScene {
  // --- scene graph ---------------------------------------------------------
  const fxBelow = new Container();
  const fxAbove = new Container();
  const scrollRoot = new Container();
  const contentScaled = new Container();
  const pixelScroll = new Container();

  const mesh = createNoteMesh();
  const grid = createGrid();
  const labels = createLabelLayer();

  contentScaled.addChild(grid.barLines, mesh.mesh);
  pixelScroll.addChild(labels.barNumbers, labels.noteLabels);
  scrollRoot.addChild(contentScaled, pixelScroll);
  app.stage.addChild(grid.pitchLines, fxBelow, scrollRoot, fxAbove);

  // The app is created with `autoStart: false`: nothing renders until a
  // mutator below requests a frame or an FX updater reports it is animating.
  const scheduler = createRenderScheduler(app.ticker);

  // --- state ---------------------------------------------------------------
  let visuals: NoteVisual[] = [];
  let visualById = new Map<string, NoteVisual>();
  let tracker: OnsetTracker | null = null;
  /** Defer the tracker re-anchor to the next setScroll, which carries the
   *  post-seek cursor — `reset()` itself has no beat to anchor at. */
  let pendingTrackerReset = true;
  let tempoScale = 1;
  let notesWidth = 0;
  let laneHeight = 0;
  let scrollSec = 0;
  // Vertical zoom. The effective px/authored-second is PX_PER_SECOND * spread,
  // the single scale every content/pixel mapping below derives from. `lastDpr`
  // is retained so a spread change can rewrite the note SDF uniform (which also
  // carries DPR) without waiting for a resize.
  let spread = 1;
  let lastDpr = 1;
  const pxPerSec = (): number => PX_PER_SECOND * spread;

  const noteOnSubs = new Set<(e: FxNoteEvent) => void>();
  const resetSubs = new Set<() => void>();

  // Memoized CSS→number resolution: scores reuse a handful of track colors, so
  // the probe-element round-trip runs once per distinct expression per theme.
  const colorCache = new Map<string, number>();
  const resolveColor = (expr: string): number => {
    let color = colorCache.get(expr);
    if (color === undefined) {
      color = resolveCssColor(expr);
      colorCache.set(expr, color);
    }
    return color;
  };

  const applyScroll = (): void => {
    // The DOM ScrollLayer formula, verbatim: the cursor maps to the lane
    // bottom (the keyboard), content above it is the future. Snapped to the
    // device-pixel grid: a fractional offset lands every note edge and glyph
    // between two physical pixels, so mid-scroll the anti-aliased edges and
    // the bitmap labels resample soft — the roll reads blurry while it plays
    // and sharp once it stops.
    scrollRoot.y = snapToDevicePixel(
      laneHeight + scrollSec * pxPerSec(),
      lastDpr,
    );
  };

  return {
    fxLayers: { belowNotes: fxBelow, aboveNotes: fxAbove },

    setScore(input) {
      visuals = input.notes;
      visualById = new Map(visuals.map((v) => [v.noteId, v]));
      tempoScale = input.tempoScale;
      tracker = createOnsetTracker(input.scoreNotes);
      pendingTrackerReset = true;

      mesh.setNotes(visuals, resolveColor);
      grid.setBars(input.bars);
      grid.setPitchLines(input.pitchLines);
      grid.refreshColors(resolveColor);
      labels.setNotes(visuals);
      labels.setBars(input.bars);
      labels.refreshColors(resolveColor);
      scheduler.request();
    },

    resize(width, keysWidth, height, dpr) {
      notesWidth = keysWidth;
      laneHeight = height;
      lastDpr = dpr;
      app.renderer.resize(width, height, dpr);
      // THE payoff of authored-space geometry: a resize is one container
      // scale + two uniforms + a couple of redrawn octave lines — O(1) in
      // note count, vs. the DOM version's per-note style writes.
      contentScaled.scale.set(keysWidth, pxPerSec());
      mesh.setUniforms(keysWidth, dpr, pxPerSec());
      grid.resize(width, keysWidth, height);
      labels.setLaneSize(keysWidth, height, dpr);
      applyScroll();
      scheduler.request();
    },

    setSpread(nextSpread) {
      if (nextSpread === spread) return;
      spread = nextSpread;
      // Notes are stored in authored seconds, so a zoom is just a rescale of
      // the content layer + the SDF pixel-budget uniform — no buffer rebuild.
      // The grid (bar-line height) and labels (pixel-space positions/fonts)
      // each re-derive from the new effective px/sec; then re-glue the scroll.
      contentScaled.scale.set(notesWidth, pxPerSec());
      mesh.setUniforms(notesWidth, lastDpr, pxPerSec());
      grid.setSpread(spread);
      labels.setSpread(pxPerSec());
      applyScroll();
      scheduler.request();
    },

    setScroll(authoredSec, cursorBeat) {
      scrollSec = authoredSec;
      applyScroll();
      labels.update(authoredSec);
      scheduler.request();

      if (!tracker) return;
      if (pendingTrackerReset) {
        // First frame after a score change / seek: re-anchor without firing
        // the onsets the jump skipped over (navigation, not performance).
        pendingTrackerReset = false;
        tracker.reset(cursorBeat);
        return;
      }
      const fired = tracker.advance(cursorBeat);
      if (fired.length === 0 || noteOnSubs.size === 0) return;
      for (const note of fired) {
        const v = visualById.get(note.id);
        if (!v) continue; // hidden track — no visual, no FX
        const event: FxNoteEvent = {
          note,
          x: v.xFrac * notesWidth,
          width: v.wFrac * notesWidth,
          laneY: laneHeight,
          color: resolveColor(v.colorExpr),
          velocity: note.velocity / 127,
          isAccidental: v.isAccidental,
          durationSeconds: (v.y1Sec - v.y0Sec) / tempoScale,
        };
        for (const cb of noteOnSubs) cb(event);
        // An onset gave FX something to animate (setScroll already requested
        // this frame; the updaters then keep the loop alive until they settle).
        scheduler.request();
      }
    },

    reset() {
      pendingTrackerReset = true;
      for (const cb of resetSubs) cb();
      // FX just cleared their in-flight state — draw the emptied layers.
      scheduler.request();
    },

    setShowLabels(on) {
      labels.setVisible(on);
      scheduler.request();
    },

    setLook(look) {
      const style = SONATA_LOOK_STYLES[look];
      mesh.setLook(style.pen, style.notes);
      grid.setLook(style.grid, resolveColor);
      labels.setLook(style.labels, resolveColor);
      scheduler.request();
    },

    refreshColors() {
      // The token VALUES changed (theme flip) — every cached resolution is
      // stale. Re-resolve and rewrite the color buffer + tints; geometry and
      // label glyphs are untouched.
      colorCache.clear();
      mesh.recolor(visuals, resolveColor);
      grid.refreshColors(resolveColor);
      labels.refreshColors(resolveColor);
      scheduler.request();
    },

    onNoteOn(cb) {
      noteOnSubs.add(cb);
      return () => noteOnSubs.delete(cb);
    },

    onReset(cb) {
      resetSubs.add(cb);
      return () => resetSubs.delete(cb);
    },

    onFrame: (update) => scheduler.onFrame(update),

    halt() {
      scheduler.halt();
    },

    destroy() {
      scheduler.halt();
      noteOnSubs.clear();
      resetSubs.clear();
      mesh.destroy();
      grid.destroy();
      labels.destroy();
      // FX containers and the scroll/content shells (their children are
      // already destroyed above; FX children belong to FX plugins, which
      // unmount before the scene dies).
      app.stage.removeChildren();
      fxBelow.destroy({ children: true });
      fxAbove.destroy({ children: true });
      scrollRoot.destroy({ children: true });
    },
  };
}
