/**
 * Grid layers for the canvas piano roll: time-axis BAR LINES and pitch-axis
 * PITCH LINES — the canvas replacements for the DOM `GridLines`/`OctaveLines`
 * components.
 *
 * Two different spaces, mirroring the DOM version's layering:
 *
 *  - Bar lines scroll with the notes, so they live in CONTENT space (authored
 *    units: x in 0..1 key-fractions, y = -seconds) under the content-scaled
 *    container. A line is a filled rect of height 1/PX_PER_SECOND seconds —
 *    scale.y is the constant PX_PER_SECOND, so it renders exactly 1px at any
 *    lane size. A rule runs the LANE's width, which may exceed the keys' (the
 *    roll bleeds under a host's chrome — see `resize`), so it is
 *    `laneWidth / notesWidth` key-fractions wide. Built once per score, and
 *    again only when a resize changes that ratio.
 *
 *  - Pitch lines mark a fixed pitch axis, so they are SCREEN-space (a direct
 *    stage child): vertical 1px lines at the natural white-key boundaries
 *    (B–C octave splits, plus the E–F mid-octave split), at each boundary key's
 *    left-edge fraction × the keys' width, full lane height. Octave (B–C) lines render
 *    stronger than the mid-octave (E–F) lines. Redrawn on resize only.
 *
 * Color: both layers draw WHITE geometry and carry a tint + per-layer alpha
 * taken from the active LOOK (`SonataLookStyle["grid"]`), never from the theme.
 * The lane is a fixed stage — Synthesia-dark under the digital looks, cream paper under
 * `sketch` — in every theme, so the grid is theme-independent by design and not
 * the `var(--border)` token (which would vanish on the dark lane under a dark
 * theme). A look is NOT a theme: it swaps which fixed palette this handle is
 * pinned to, which is why the ink is STORED here — `refreshColors` (a theme
 * flip) re-resolves the stored expression and cannot clobber an active look.
 * Both remain tint/alpha writes plus, for a dashed rule, one pitch-line redraw.
 */
import { Graphics } from "pixi.js";
import type { SonataLookStyle } from "@plugins/apps/plugins/sonata/plugins/look/core";
import {
  SONATA_DEFAULT_LOOK,
  SONATA_LOOK_STYLES,
} from "@plugins/apps/plugins/sonata/plugins/look/core";
import type { PitchGuide } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { PX_PER_SECOND } from "../../components/geometry";

/**
 * One bar marker, in authored seconds (built by the host from the axis's bar
 * lines). `index` is the bar's index in `bars(score)` — drawn as its number —
 * or `null` for an unnumbered line (the one opening an unrolled loop's rest).
 */
export interface BarMarker {
  index: number | null;
  startSec: number;
  /** Each beat inside the bar after its downbeat, in authored seconds — the
   *  fainter beat rules a look may draw (`grid.beatLineAlpha`). */
  beatSecs: readonly number[];
}

export interface GridHandle {
  /** Bar lines — mount under the CONTENT-SCALED container. */
  barLines: Graphics;
  /** Pitch lines — mount directly on the stage (screen space, below notes). */
  pitchLines: Graphics;
  /** Rebuild the bar lines (once per score). */
  setBars(bars: readonly BarMarker[]): void;
  /** Set the pitch-axis boundary lines (once per score). */
  setPitchLines(lines: readonly PitchGuide[]): void;
  /** New vertical zoom: redraw the bar lines so each stays 1px tall under the
   *  content scale.y = PX_PER_SECOND * spread. O(bars). */
  setSpread(spread: number): void;
  /** Redraw for a new lane size: `laneWidth` is the whole canvas (the bar
   *  rules' span), `notesWidth` the keys' part of it from the left edge (the
   *  pitch rules' axis). */
  resize(laneWidth: number, notesWidth: number, laneHeight: number): void;
  /** New look: store its grid ink and repaint. Never rebuilds the handle — the
   *  scene (and the FX plugins holding its layers) outlives every look change. */
  setLook(
    ink: SonataLookStyle["grid"],
    resolveColor: (expr: string) => number,
  ): void;
  /** Re-tint both layers from the STORED look ink, re-resolved. */
  refreshColors(resolveColor: (expr: string) => number): void;
  destroy(): void;
}

export function createGrid(): GridHandle {
  const barLines = new Graphics();
  // Per-pitch-line alpha is baked into each fill (octave vs mid-octave), so that
  // container stays at full opacity and only carries the shared tint; the bar
  // lines carry theirs on the container.
  const pitchLines = new Graphics();

  // The active look's grid ink. Seeded with the default look so a grid drawn
  // before the first `setLook` is the default one — the same constants this
  // module used to hold literally.
  let ink: SonataLookStyle["grid"] =
    SONATA_LOOK_STYLES[SONATA_DEFAULT_LOOK].grid;
  barLines.alpha = ink.barLineAlpha;

  let lines: readonly PitchGuide[] = [];
  let notesWidth = 0;
  let laneHeight = 0;
  // How many key-fractions a bar rule spans: the lane over the keys' width.
  let ruleSpan = 1;
  // Bars + zoom retained so a spread change can redraw bar lines at the right
  // (zoom-compensated) authored-seconds height without a fresh score.
  let lastBars: readonly BarMarker[] = [];
  let spread = 1;

  const redrawBars = (): void => {
    barLines.clear();
    const h = 1 / (PX_PER_SECOND * spread);
    // The beat rules share the bar lines' container, whose alpha is the bar
    // line's: a beat's own fill alpha is its share of it, so the two read at
    // exactly the look's two strengths.
    const beatAlpha =
      ink.barLineAlpha > 0
        ? Math.min(1, ink.beatLineAlpha / ink.barLineAlpha)
        : 0;
    for (const b of lastBars) {
      // The DOM drew `border-t` at the bar's content Y, extending 1px DOWN
      // (toward earlier time). y = -startSec; height = 1px after the content
      // scale.y = PX_PER_SECOND * spread, so the authored-seconds height is
      // 1 / (PX_PER_SECOND * spread) to stay exactly 1px at any zoom.
      barLines.rect(0, -b.startSec, ruleSpan, h).fill(0xffffff);
      if (beatAlpha <= 0) continue;
      for (const sec of b.beatSecs) {
        barLines
          .rect(0, -sec, ruleSpan, h)
          .fill({ color: 0xffffff, alpha: beatAlpha });
      }
    }
  };

  const redrawPitchLines = (): void => {
    pitchLines.clear();
    if (notesWidth <= 0 || laneHeight <= 0) return;
    for (const { frac, strong } of lines) {
      // 1px vertical line whose LEFT edge sits on the boundary key's left edge —
      // matching the DOM's `border-l` at `left: center - width/2`.
      const x = frac * notesWidth;
      const alpha = strong ? ink.octaveLineAlpha : ink.pitchLineAlpha;
      const dash = strong ? ink.octaveDash : null;
      // A zero-length period would never advance `y` — treat it as solid.
      if (!dash || dash[0] + dash[1] <= 0) {
        pitchLines.rect(x, 0, 1, laneHeight).fill({ color: 0xffffff, alpha });
        continue;
      }
      // Pixi Graphics has no dash, so a dashed rule IS a run of rects. At [7,6]
      // over an 800px lane that's ~60 per octave line, emitted only on resize or
      // a look change — nothing next to the note mesh's per-frame draw.
      const [on, off] = dash;
      const period = on + off;
      for (let y = 0; y < laneHeight; y += period) {
        const h = Math.min(on, laneHeight - y);
        pitchLines.rect(x, y, 1, h).fill({ color: 0xffffff, alpha });
      }
    }
  };

  /** Push the stored ink onto both layers: the tint + the bar-line container
   *  alpha are writes, the per-fill pitch-line alphas need the redraw. */
  const applyInk = (resolveColor: (expr: string) => number): void => {
    const color = resolveColor(ink.colorExpr);
    barLines.tint = color;
    barLines.alpha = ink.barLineAlpha;
    pitchLines.tint = color;
    redrawBars();
    redrawPitchLines();
  };

  return {
    barLines,
    pitchLines,

    setBars(bars) {
      lastBars = bars;
      redrawBars();
    },

    setPitchLines(pitchBoundaries) {
      lines = pitchBoundaries;
      redrawPitchLines();
    },

    setSpread(nextSpread) {
      spread = nextSpread;
      redrawBars();
    },

    resize(width, keysWidth, height) {
      notesWidth = keysWidth;
      laneHeight = height;
      redrawPitchLines();
      const span = keysWidth > 0 ? width / keysWidth : 1;
      if (span !== ruleSpan) {
        ruleSpan = span;
        redrawBars();
      }
    },

    setLook(nextInk, resolveColor) {
      ink = nextInk;
      applyInk(resolveColor);
    },

    refreshColors(resolveColor) {
      // A theme flip re-resolves the STORED look expression — a look survives
      // it untouched (see the header note).
      applyInk(resolveColor);
    },

    destroy() {
      barLines.destroy();
      pitchLines.destroy();
    },
  };
}
