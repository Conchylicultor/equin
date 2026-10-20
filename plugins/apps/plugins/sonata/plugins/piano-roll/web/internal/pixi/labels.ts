/**
 * Text layers for the canvas piano roll: Synthesia-style NOTE-NAME labels and
 * BAR NUMBERS — the canvas replacement for the DOM `<span>` labels that lived
 * inside each note div and the bar-number spans inside `GridLines`.
 *
 * Both live in the PIXEL-SPACE scroll container (`pixelScroll` in the scene):
 * it shares the content layers' per-frame translateY but has NO content scale,
 * so glyphs never distort under the lane's non-uniform (width × time) scale.
 * Positions are therefore authored as `y = -seconds × PX_PER_SECOND` pixels.
 *
 * Note labels are POOLED + WINDOWED: a score can carry thousands of notes but
 * only ~30–150 onsets are on screen at once. `createLabelWindow` binary-searches
 * the notes-sorted-by-onset array for the visible onset range; pooled sprites
 * are acquired/released as the window slides. A hard cap (largest-fontPx-first,
 * i.e. most-legible-first) bounds the worst case — a simple priority that's
 * deliberately v1 (no spatial de-clutter).
 *
 * DRAWING (documented decision): each label is painted the way the Sonata
 * prototype paints it — Canvas 2D `strokeText` then `fillText`, bold Manrope,
 * a 45%-black round-joined outline ~0.2em wide, the accidental RAISED like a
 * superscript at 0.66× in the system face (so a narrow black-key note reads C♯,
 * not "Cs") — into a canvas at the DEVICE resolution and the label's exact
 * size, uploaded once as a texture shared by every label with the same
 * (face, name, size). Not a BitmapFont: an atlas rasterized at one size and
 * resampled 4–5× down to a 14px label softens and pales the thin outline, so
 * it never matched the prototype; a texture drawn at the final size is the
 * prototype's pixels by construction. The set of live textures is tiny (seven
 * letters × three accidentals × the couple of sizes a lane width yields) and
 * is pruned to the ones in use on every full re-pass (resize, zoom).
 *
 * `loadLabelFonts()` must settle before the first label is drawn, or the
 * texture bakes the fallback face. The face is a LOOK choice
 * (white-with-a-dark-halo for the dark lane, graphite-with-a-paper-halo for the
 * drawn one): the ink is STORED, so `refreshColors` (a theme flip) cannot
 * clobber an active look — a look is not a theme. Bar numbers stay a tinted
 * BitmapFont: they carry no outline.
 */
import {
  BitmapFont,
  BitmapText,
  CanvasSource,
  Container,
  Sprite,
  Texture,
} from "pixi.js";
import type { SonataLookStyle } from "@plugins/apps/plugins/sonata/plugins/look/core";
import {
  SONATA_DEFAULT_LOOK,
  SONATA_LOOK_STYLES,
} from "@plugins/apps/plugins/sonata/plugins/look/core";
import { PX_PER_SECOND, type NoteVisual } from "../../components/geometry";
import type { BarMarker } from "./grid";

// --- pure sizing / windowing (unit-tested, no Pixi/DOM needed at runtime) ------

/**
 * Font size (px) for a falling-bar note name: a fraction of the key width
 * (0.78 for a bare letter, 0.72 when a raised accidental rides along), held in
 * a narrow 11–17px band so every name reads at about one size — a wide white
 * key does not get a shouting letter, a black key's name stays legible — and
 * capped at 85% of the bar height. Returns null when the label is skipped: a
 * bar too short to hold one (≤ 11px), or a column so narrow (zoomed far out)
 * that even the band's floor would spill well past it.
 */
export function noteLabelFontPx(
  keyWidth: number,
  barHeight: number,
  hasAccidental: boolean,
): number | null {
  const MIN_BAR_PX = 11;
  const FLOOR = 11;
  const CEILING = 17;
  /** Below this width-fit the floor would overflow the column — skip. */
  const LEGIBLE_FIT = 7;
  if (barHeight <= MIN_BAR_PX) return null;
  const widthFit = keyWidth * (hasAccidental ? 0.72 : 0.78);
  if (widthFit < LEGIBLE_FIT) return null;
  return Math.min(
    Math.max(FLOOR, Math.min(CEILING, widthFit)),
    barHeight * 0.85,
  );
}

/** Where a label's baseline sits above its bar's bottom edge, in px. */
export function noteLabelBaselineInset(fontPx: number): number {
  return Math.max(4, fontPx * 0.3);
}

/**
 * Windowing helper: given notes SORTED ASCENDING by onset (`y0Sec`), returns a
 * query for the half-open index range `[start, end)` of notes whose onset lies
 * in `[minSec, maxSec]` — two binary searches, O(log n) per frame. Pure.
 */
export function createLabelWindow(
  notesSortedByOnset: readonly { y0Sec: number }[],
): (minSec: number, maxSec: number) => { start: number; end: number } {
  const notes = notesSortedByOnset;
  /** First index whose onset satisfies `predicate threshold` semantics. */
  const lowerBound = (sec: number): number => {
    // First idx with y0Sec >= sec.
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid]!.y0Sec < sec) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const upperBound = (sec: number): number => {
    // First idx with y0Sec > sec.
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid]!.y0Sec <= sec) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (minSec, maxSec) => ({
    start: lowerBound(minSec),
    end: upperBound(maxSec),
  });
}

// --- label drawing ----------------------------------------------------------------

/** The note-name family: the Sonata theme's Manrope. */
const LABEL_FAMILY = "Manrope, ui-sans-serif, system-ui, sans-serif";
/** The accidental's family: the system face, whose ♯/♭ Manrope lacks. */
const ACCIDENTAL_FAMILY = "ui-sans-serif, system-ui, sans-serif";
const LABEL_WEIGHT = "700";

/** The accidental's size relative to the letter (with a floor), and how far
 *  (in letter-px) its baseline rises above the letter's. */
const ACCIDENTAL_SCALE = 0.66;
const ACCIDENTAL_MIN_PX = 8;
const ACCIDENTAL_RISE = 0.38;

/** Font sizes are quantized so near-equal sizes share one texture. */
const FONT_PX_STEP = 0.25;

/** Each look face's ink: the letter's fill and its outline. Both are literals,
 *  like the prototype's — the face is a rasterized asset, not a palette read. */
const FACE_INKS: Record<
  SonataLookStyle["labels"]["face"],
  { fill: string; outline: string }
> = {
  "light-on-dark": { fill: "#ffffff", outline: "rgba(0, 0, 0, 0.45)" },
  "ink-on-paper": { fill: "#2c2926", outline: "rgba(247, 242, 229, 0.85)" },
};

/**
 * Wait for the note-name face to be ready to rasterize. The theme loads
 * Manrope from Google Fonts with `display=swap`, so on a cold page it is
 * usually still in flight when the roll mounts; `document.fonts.load` joins
 * (or starts) that fetch. Resolves either way — a face that never arrives
 * (offline) leaves the fallback, which is the CSS behaviour too.
 */
export async function loadLabelFonts(): Promise<void> {
  await document.fonts.load(`${LABEL_WEIGHT} 32px Manrope`, "ABCDEFG");
}

/** A drawn label: its texture, and the anchor (fractions of the texture) that
 *  falls on the label's centre at its baseline. */
interface LabelArt {
  texture: Texture;
  anchorX: number;
  anchorY: number;
}

/**
 * Paint one label as the prototype does: letter stroke + fill, then the
 * raised accidental's stroke + fill, the pair centred as one mark. Drawn in
 * CSS px scaled by `resolution`, into a canvas just large enough to hold the
 * glyphs' measured ink plus the outline.
 */
function drawLabel(
  step: string,
  accidental: string,
  fontPx: number,
  face: SonataLookStyle["labels"]["face"],
  resolution: number,
): LabelArt {
  const ink = FACE_INKS[face];
  const accPx = Math.max(ACCIDENTAL_MIN_PX, fontPx * ACCIDENTAL_SCALE);
  const letterFont = `${LABEL_WEIGHT} ${fontPx}px ${LABEL_FAMILY}`;
  const accFont = `${LABEL_WEIGHT} ${accPx}px ${ACCIDENTAL_FAMILY}`;
  const outline = Math.max(2.2, fontPx * 0.2);
  const rise = fontPx * ACCIDENTAL_RISE;

  const canvas = document.createElement("canvas");
  const measure = canvas.getContext("2d");
  if (!measure) throw new Error("piano-roll labels: no 2d canvas context");
  measure.font = letterFont;
  const letter = measure.measureText(step);
  measure.font = accFont;
  const acc = accidental === "" ? null : measure.measureText(accidental);
  // The accidental is tucked half a pixel into the letter (the prototype's
  // overlap), and the pair's advance is what centres on the column.
  const accAdvance = acc ? acc.width - 0.5 : 0;
  const advance = letter.width + accAdvance;

  // Ink extents about the baseline, padded by the outline's outer half.
  const pad = Math.ceil(outline / 2) + 1;
  const ascent = Math.max(
    letter.actualBoundingBoxAscent,
    acc ? rise + acc.actualBoundingBoxAscent : 0,
  );
  const descent = Math.max(
    letter.actualBoundingBoxDescent,
    acc ? acc.actualBoundingBoxDescent - rise : 0,
  );
  const cssW = advance + 2 * pad;
  const cssH = ascent + descent + 2 * pad;
  const pxW = Math.max(1, Math.ceil(cssW * resolution));
  const pxH = Math.max(1, Math.ceil(cssH * resolution));
  canvas.width = pxW;
  canvas.height = pxH;

  const source = new CanvasSource({ resource: canvas, resolution });
  const ctx = source.context2D;
  ctx.scale(resolution, resolution);
  ctx.lineJoin = "round";
  ctx.lineWidth = outline;
  ctx.strokeStyle = ink.outline;
  ctx.fillStyle = ink.fill;
  const baseline = pad + ascent;
  ctx.font = letterFont;
  ctx.strokeText(step, pad, baseline);
  ctx.fillText(step, pad, baseline);
  if (acc) {
    const ax = pad + letter.width - 0.5;
    ctx.font = accFont;
    ctx.strokeText(accidental, ax, baseline - rise);
    ctx.fillText(accidental, ax, baseline - rise);
  }
  source.update();

  return {
    texture: new Texture({ source }),
    anchorX: ((pad + advance / 2) * resolution) / pxW,
    anchorY: (baseline * resolution) / pxH,
  };
}

// --- bar-number font ---------------------------------------------------------------

const BAR_FONT = "piano-roll-bar-number";

/** Hard cap on live note labels. Sliced largest-fontPx-first so when the
 *  window is overfull the most legible labels win (simple v1 priority). */
const MAX_LIVE_LABELS = 300;

/** Bar numbers: the DOM used `text-3xs` (0.625rem) `muted-foreground/70`. */
const BAR_FONT_PX = 10;
const BAR_NUMBER_ALPHA = 0.7;

let fontsInstalled = false;

/** Install the bar-number face once per page (BitmapFont registries are
 *  global; a second install with the same name would throw). */
function ensureFonts(): void {
  if (fontsInstalled) return;
  fontsInstalled = true;
  BitmapFont.install({
    name: BAR_FONT,
    style: {
      fontFamily: "Inter, sans-serif",
      fontWeight: "400",
      fontSize: 32,
      fill: 0xffffff, // white face; the live tint carries the muted token
    },
    chars: [["0", "9"]],
    resolution: 2,
  });
}

// --- pooled, windowed label layer -------------------------------------------------

/** One pooled label: a sprite showing a drawn label's texture. */
type PooledLabel = Sprite;

interface LabelEntry {
  v: NoteVisual;
  step: string;
  accidental: string;
}

export interface LabelLayerHandle {
  /** Note-name labels — mount under the PIXEL-SPACE scroll container. */
  noteLabels: Container;
  /** Bar numbers — mount under the PIXEL-SPACE scroll container. */
  barNumbers: Container;
  setNotes(visuals: readonly NoteVisual[]): void;
  setBars(bars: readonly BarMarker[]): void;
  /** New lane size (and device pixel ratio, which labels are drawn at):
   *  re-derives every live label's font size and x position. */
  setLaneSize(width: number, height: number, resolution: number): void;
  /** New vertical zoom (effective `PX_PER_SECOND * spread`): re-places every
   *  pixel-space label and bar number and re-derives the visible window. */
  setSpread(pxPerSec: number): void;
  setVisible(on: boolean): void;
  /** Per-frame: slide the label window to the current scroll position. */
  update(scrollSec: number): void;
  /** New look: redraw every live label in the look's face and re-tint the
   *  bar numbers. Never rebuilds the handle. */
  setLook(
    ink: SonataLookStyle["labels"],
    resolveColor: (expr: string) => number,
  ): void;
  refreshColors(resolveColor: (expr: string) => number): void;
  destroy(): void;
}

/** Extra onset range kept live beyond the visible lane, so labels at the edges
 *  don't pop as they cross in/out (~32px worth of seconds, at the live zoom). */
const WINDOW_PAD_PX = 32;

export function createLabelLayer(): LabelLayerHandle {
  ensureFonts();

  const noteLabels = new Container();
  const barNumbers = new Container();
  const barTexts: BitmapText[] = [];

  // Notes sorted by onset (the windowing order) + the matching window query.
  let entries: LabelEntry[] = [];
  let windowOf: (
    min: number,
    max: number,
  ) => { start: number; end: number } = () => ({ start: 0, end: 0 });

  let laneWidth = 0;
  let laneHeight = 0;
  let lastScrollSec = 0;
  // Effective pixels-per-authored-second = PX_PER_SECOND * spread. Labels live
  // in the unscaled pixel layer, so every authored-seconds → pixel conversion
  // here multiplies by this (not the bare constant). Bars retained so a spread
  // change can re-place the bar numbers without a fresh score.
  let pxPerSec = PX_PER_SECOND;
  let lastBars: readonly BarMarker[] = [];
  let dirty = true; // forces the next update() to re-place everything
  // The active look's text ink. Seeded with the default look, so labels drawn
  // before the first `setLook` are the default ones — the same face and token
  // this module used to name literally.
  let ink: SonataLookStyle["labels"] =
    SONATA_LOOK_STYLES[SONATA_DEFAULT_LOOK].labels;

  let resolution = 1;

  // Drawn labels, keyed by face + name + quantized size. Pruned to the ones in
  // use on every full re-pass (`dirty`), so it holds what is on screen plus
  // whatever scrolled in since the last resize or zoom.
  const art = new Map<string, LabelArt>();
  const artFor = (e: LabelEntry, fontPx: number): LabelArt => {
    const key = `${ink.face}|${e.step}${e.accidental}|${fontPx}`;
    let drawn = art.get(key);
    if (!drawn) {
      drawn = drawLabel(e.step, e.accidental, fontPx, ink.face, resolution);
      art.set(key, drawn);
    }
    return drawn;
  };
  const clearArt = (): void => {
    for (const drawn of art.values()) drawn.texture.destroy(true);
    art.clear();
  };

  // Pool: live labels keyed by entry index, plus a free list.
  const active = new Map<number, PooledLabel>();
  const free: PooledLabel[] = [];

  const acquire = (): PooledLabel => {
    const pooled = free.pop();
    if (pooled) {
      pooled.visible = true;
      return pooled;
    }
    const sprite = new Sprite(Texture.EMPTY);
    noteLabels.addChild(sprite);
    return sprite;
  };

  const release = (pooled: PooledLabel): void => {
    pooled.visible = false;
    // Never left holding a texture a prune may destroy.
    pooled.texture = Texture.EMPTY;
    free.push(pooled);
  };

  /**
   * Place one label at the foot of its bar, centred on the key column, its
   * baseline `noteLabelBaselineInset` above the bar's bottom edge (-y0·px - 1)
   * — the prototype's `y1 - max(4, fs·0.3)`, measured to land on the same
   * pixel row (letter to note edge) as the prototype's.
   */
  const place = (pooled: PooledLabel, e: LabelEntry, fontPx: number): void => {
    const drawn = artFor(e, fontPx);
    pooled.texture = drawn.texture;
    pooled.anchor.set(drawn.anchorX, drawn.anchorY);
    pooled.x = (e.v.xFrac + e.v.wFrac / 2) * laneWidth;
    pooled.y = -e.v.y0Sec * pxPerSec - 1 - noteLabelBaselineInset(fontPx);
  };

  let lastStart = 0;
  let lastEnd = 0;

  const refreshWindow = (scrollSec: number): void => {
    lastScrollSec = scrollSec;
    if (!noteLabels.visible || laneHeight <= 0 || laneWidth <= 0) return;
    // Visible authored-seconds range: lane bottom is the cursor (scrollSec),
    // lane top is laneHeight px further into the future. Both the lane height
    // and the edge pad are pixel quantities, so they convert at the live zoom.
    const padSec = WINDOW_PAD_PX / pxPerSec;
    const minSec = scrollSec - padSec;
    const maxSec = scrollSec + laneHeight / pxPerSec + padSec;
    const { start, end } = windowOf(minSec, maxSec);
    if (!dirty && start === lastStart && end === lastEnd) return;
    lastStart = start;
    lastEnd = end;
    const fullPass = dirty;
    dirty = false;

    // Candidates: windowed entries whose label legibly fits, capped at
    // MAX_LIVE_LABELS keeping the LARGEST fonts (most legible first).
    let candidates: { idx: number; fontPx: number }[] = [];
    for (let idx = start; idx < end; idx++) {
      const e = entries[idx]!;
      const fontPx = noteLabelFontPx(
        e.v.wFrac * laneWidth,
        (e.v.y1Sec - e.v.y0Sec) * pxPerSec,
        e.accidental !== "",
      );
      if (fontPx !== null) {
        candidates.push({
          idx,
          fontPx: Math.round(fontPx / FONT_PX_STEP) * FONT_PX_STEP,
        });
      }
    }
    if (candidates.length > MAX_LIVE_LABELS) {
      candidates = candidates
        .sort((a, b) => b.fontPx - a.fontPx)
        .slice(0, MAX_LIVE_LABELS);
    }

    const keep = new Map(candidates.map((c) => [c.idx, c.fontPx]));
    for (const [idx, pooled] of active) {
      if (!keep.has(idx)) {
        release(pooled);
        active.delete(idx);
      }
    }
    for (const { idx, fontPx } of candidates) {
      let pooled = active.get(idx);
      if (!pooled) {
        pooled = acquire();
        active.set(idx, pooled);
      }
      // Re-place unconditionally: cheap (a cached texture), and it keeps the
      // resize path trivially correct (laneWidth changed ⇒ dirty ⇒ full pass).
      place(pooled, entries[idx]!, fontPx);
    }
    if (fullPass) {
      // Every live label now holds its current art: drop the rest.
      const inUse = new Set<Texture>(
        [...active.values()].map((pooled) => pooled.texture),
      );
      for (const [key, drawn] of art) {
        if (!inUse.has(drawn.texture)) {
          drawn.texture.destroy(true);
          art.delete(key);
        }
      }
    }
  };

  return {
    noteLabels,
    barNumbers,

    setNotes(visuals) {
      // Keep only labeled notes, sorted by onset for the binary-search window.
      entries = visuals
        .filter((v) => v.label !== null)
        .map((v) => ({
          v,
          step: v.label!.step,
          accidental: v.label!.accidental,
        }))
        .sort((a, b) => a.v.y0Sec - b.v.y0Sec);
      windowOf = createLabelWindow(entries.map((e) => e.v));
      // Window indices refer to a new array — drop every live label.
      for (const pooled of active.values()) release(pooled);
      active.clear();
      dirty = true;
      refreshWindow(lastScrollSec);
    },

    setBars(bars) {
      // Only numbered bars carry a number (an unrolled loop's rest opens with
      // an unnumbered line); `lastBars` stays parallel to `barTexts`.
      lastBars = bars.filter((b) => b.index !== null);
      for (const t of barTexts) t.destroy();
      barTexts.length = 0;
      for (const b of lastBars) {
        const text = new BitmapText({
          text: String(b.index! + 1),
          style: { fontFamily: BAR_FONT, fontSize: BAR_FONT_PX },
          // The DOM span sat `left-1 top-0.5` under the bar line.
          x: 4,
          y: -b.startSec * pxPerSec + 2,
          alpha: BAR_NUMBER_ALPHA,
        });
        barTexts.push(text);
        barNumbers.addChild(text);
      }
    },

    setLaneSize(width, height, nextResolution) {
      if (
        width === laneWidth &&
        height === laneHeight &&
        nextResolution === resolution
      ) {
        return;
      }
      if (nextResolution !== resolution) {
        // Every drawn label is at the old density: redraw them all.
        for (const pooled of active.values()) pooled.texture = Texture.EMPTY;
        clearArt();
        resolution = nextResolution;
      }
      laneWidth = width;
      laneHeight = height;
      dirty = true;
      refreshWindow(lastScrollSec);
    },

    setSpread(nextPxPerSec) {
      if (nextPxPerSec === pxPerSec) return;
      pxPerSec = nextPxPerSec;
      // Bar numbers live in the unscaled layer, so re-place them at the new zoom.
      for (let i = 0; i < barTexts.length; i++) {
        barTexts[i]!.y = -lastBars[i]!.startSec * pxPerSec + 2;
      }
      // Note labels: font size + Y both depend on the zoom → full re-pass.
      dirty = true;
      refreshWindow(lastScrollSec);
    },

    setVisible(on) {
      if (noteLabels.visible === on) return;
      noteLabels.visible = on;
      if (on) {
        dirty = true;
        refreshWindow(lastScrollSec);
      }
    },

    update(scrollSec) {
      refreshWindow(scrollSec);
    },

    setLook(nextInk, resolveColor) {
      // The face is part of the art key, so a full re-pass redraws every live
      // label in the new face and prunes the old face's art.
      if (nextInk.face !== ink.face) dirty = true;
      ink = nextInk;
      const barColor = resolveColor(ink.barNumberExpr);
      for (const t of barTexts) t.tint = barColor;
      if (dirty) refreshWindow(lastScrollSec);
    },

    refreshColors(resolveColor) {
      // Note labels are a face plus a baked halo — theme-invariant by design. Only the bar numbers carry a colour, and it is the
      // STORED look's, re-resolved: a theme flip cannot clobber a look.
      const barColor = resolveColor(ink.barNumberExpr);
      for (const t of barTexts) t.tint = barColor;
    },

    destroy() {
      noteLabels.destroy({ children: true });
      clearArt();
      barNumbers.destroy({ children: true });
      // Pooled-but-detached labels were children of noteLabels, so they are
      // covered by the recursive destroy above.
      active.clear();
      free.length = 0;
    },
  };
}
