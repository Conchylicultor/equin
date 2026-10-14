import type { SonataLook } from "./config";

/**
 * The keys of the ONE look that draws them itself: the hand-drawn skin's palette,
 * handed to the SVG layer that paints the outlines (`sketch-skin.tsx`).
 */
export interface SonataDrawnKeys {
  skin: "drawn";
  ivory: string;
  ebony: string;
  ink: string;
  shade: number;
}

/**
 * Which skin a look wears on the 88 keys below the lane, and — for the one that
 * draws them — the colours it draws them in.
 *
 * A union rather than a flag plus four colours, because two of the three skins
 * have no palette to give: `flat` and `realistic` are CSS chrome the keyboard
 * paints from the theme, and only `drawn` hands colours to an SVG layer. Under a
 * flat record those four fields would have to be filled with unread values on
 * every non-drawn look; here they simply have nowhere to be written, and the
 * consumer that needs them ({@link SonataDrawnKeys}) is handed a type that
 * guarantees they are present.
 */
export type SonataKeys =
  { skin: "flat" } | { skin: "realistic" } | SonataDrawnKeys;

/**
 * The palette of ONE look: every fixed constant the roll's four surfaces used to
 * hardcode, gathered where another look can answer for them.
 *
 * Plain data, deliberately — not a slot and not a component. The set of looks is
 * CLOSED (the picker enumerates it, the palette table is exhaustive), and what
 * travels between the plugins here is colours and pen numbers, not React. Per
 * the root `CLAUDE.md` rule for closed sets, that makes it a record in `core/`.
 */
export interface SonataLookStyle {
  /** Lane background colour, written straight onto the lane div's
   *  `backgroundColor`. The Pixi canvas is transparent, so this IS the ground
   *  every layer draws on. */
  laneBg: string;
  /** Optional paper grain, as a complete CSS `background-image` value painted on
   *  the SAME lane div (over `laneBg`, under the transparent canvas). No overlay
   *  element and no blend mode: a `mix-blend-mode: multiply` layer would have to
   *  sit ABOVE the canvas to reach the notes, and would then dull them too. */
  laneGrain: string | null;
  /** The colour text set straight on the lane reads in — the lane is the
   *  look's, not the theme's, so a theme's foreground can vanish on it (dark
   *  ink on the dark digital lane). What a HUD drawn on the bare lane (the
   *  lyrics corner) writes with. */
  laneInk: string;
  /**
   * The note pen — the falling bars' shader parameters.
   *
   * `sketch` is the branch flag (0 = the flat SDF bar, unchanged), `marginPx`
   * how far outside its box the pen may write, and the rest are the prototype's
   * pen controls. `paper` is the ground the ink is drawn on, as linear 0..1 rgb,
   * because the shader mixes toward it rather than sampling the DOM behind it.
   */
  pen: {
    sketch: 0 | 1;
    marginPx: number;
    wobble: number;
    grain: number;
    stroke: number;
    wash: number;
    hatch: number;
    paper: readonly [number, number, number];
  };
  /**
   * The grid rules. One colour expression (resolved through the scene's cached
   * CSS resolver) plus a per-layer alpha, matching how the grid already paints:
   * the bar-line container carries its alpha, the pitch lines bake theirs per
   * fill. `octaveDash` is `[on, off]` in px, or null for a solid rule.
   */
  grid: {
    colorExpr: string;
    barLineAlpha: number;
    octaveLineAlpha: number;
    pitchLineAlpha: number;
    octaveDash: readonly [number, number] | null;
  };
  /**
   * The canvas text. `face` picks which installed BitmapFont the note names are
   * drawn in — a tint cannot get there, because each face bakes its own halo
   * into the glyph texture (see `labels.ts`). Bar numbers are a white face plus
   * a live tint, so they only need the expression.
   */
  labels: {
    face: "light-on-dark" | "ink-on-paper";
    barNumberExpr: string;
  };
  /** The 88 keys below the lane — which skin, and its palette if it draws. */
  keys: SonataKeys;
}

/**
 * The Synthesia stage: every roll surface shared by the two digital looks.
 *
 * These are the literals that lived in `piano-roll.tsx` (ROLL_BG), `grid.ts`
 * (the white rules and their three alphas) and `labels.ts` (the muted bar-number
 * token) before the look existed, so both looks that spread it render the lane
 * byte-for-byte what it always did.
 *
 * Extracted rather than written into each entry: `flat` and `realistic` differ
 * ONLY in the key skin, and a stage written twice is a stage that can be tweaked
 * once.
 */
const DIGITAL_ROLL: Omit<SonataLookStyle, "keys"> = {
  laneBg: "#262626",
  laneGrain: null,
  // The grid's white: the one ink the digital stage already draws in.
  laneInk: "#ffffff",
  pen: {
    sketch: 0,
    marginPx: 0,
    wobble: 0,
    grain: 0,
    stroke: 0,
    wash: 0,
    hatch: 0,
    paper: [0, 0, 0],
  },
  grid: {
    colorExpr: "#ffffff",
    barLineAlpha: 0.1,
    octaveLineAlpha: 0.24,
    pitchLineAlpha: 0.09,
    octaveDash: null,
  },
  labels: {
    face: "light-on-dark",
    barNumberExpr: "var(--muted-foreground)",
  },
};

/**
 * Every look's palette. `Record<SonataLook, …>` on purpose: a fourth look is a
 * tsc error until it has answered for the lane, the grid, the pen, the text and
 * the keys — nobody inherits another look's constants by omission.
 *
 * The `sketch` numbers are the prototype's settled defaults
 * (`~/.singularity/apps/prototypes/sketch-roll`), not fresh guesses.
 */
export const SONATA_LOOK_STYLES: Record<SonataLook, SonataLookStyle> = {
  flat: { ...DIGITAL_ROLL, keys: { skin: "flat" } },

  realistic: { ...DIGITAL_ROLL, keys: { skin: "realistic" } },

  // Cream paper, graphite pencil, ink. The lane grain is the prototype's
  // fractal-noise tile at half strength: the prototype composited it with
  // `multiply` at 0.5 opacity, and we paint it plain (no blend mode), so the
  // rect's own opacity absorbs that factor.
  sketch: {
    laneBg: "#f7f2e5",
    // The graphite the grid rules and drawn keys are inked in.
    laneInk: "#2c2926",
    laneGrain:
      "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/><feColorMatrix type='saturate' values='0'/></filter><rect width='160' height='160' filter='url(%23g)' opacity='0.13'/></svg>\")",
    pen: {
      sketch: 1,
      // The pen writes up to ~2.5px outside the note box (ghost stroke +
      // wobble). The quad has to grow by that much or every stroke is sliced
      // flat at the bounding box, exactly as it is in the prototype.
      marginPx: 2.5,
      wobble: 0.9,
      grain: 0.17,
      stroke: 1.7,
      wash: 0.74,
      hatch: 0.18,
      // #f7f2e5 as 0..1 rgb — the same cream as `laneBg`, so ink fading toward
      // the paper lands on the colour actually behind the canvas.
      paper: [0.969, 0.949, 0.898],
    },
    grid: {
      colorExpr: "#2c2926",
      barLineAlpha: 0.14,
      octaveLineAlpha: 0.26,
      pitchLineAlpha: 0.13,
      // The reference's octave rules are dashed; the rest are hairlines.
      octaveDash: [7, 6],
    },
    labels: {
      face: "ink-on-paper",
      barNumberExpr: "#6a6058",
    },
    keys: {
      skin: "drawn",
      ivory: "#fbf8ee",
      ebony: "#1d1b1a",
      ink: "#2c2926",
      shade: 0.65,
    },
  },
};
