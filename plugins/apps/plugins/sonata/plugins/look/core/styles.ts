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
 * A union rather than a flag plus four colours, because three of the four skins
 * have no palette to give: `flat`, `realistic` and `immersive` are CSS chrome
 * the keyboard paints itself, and only `drawn` hands colours to an SVG layer. Under a
 * flat record those four fields would have to be filled with unread values on
 * every non-drawn look; here they simply have nowhere to be written, and the
 * consumer that needs them ({@link SonataDrawnKeys}) is handed a type that
 * guarantees they are present.
 */
export type SonataKeys =
  | { skin: "flat" }
  | { skin: "realistic" }
  | { skin: "immersive" }
  | SonataDrawnKeys;

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
   * The falling bars' shape, in CSS px: how far each note's box is drawn in
   * from its key column on each side (`insetPx`, capped at a tenth of the
   * column so a narrow black-key note keeps its body), and its corner radius.
   * `accidentalShade` — whether a note on a black key wears its track colour's
   * darker partner (Synthesia's natural/sharp distinction) or the same colour.
   */
  notes: {
    insetPx: number;
    radiusPx: number;
    accidentalShade: boolean;
  };
  /**
   * The default colour of each track, by its index in the score (cycling) —
   * the colour a track falls in until the user picks another.
   */
  tracks: readonly string[];
  /**
   * The line the notes land on, over the keys: a colour expression and its
   * opacity.
   */
  nowLine: { colorExpr: string; alpha: number };
  /**
   * The grid rules. One colour expression (resolved through the scene's cached
   * CSS resolver) plus a per-layer alpha, matching how the grid already paints:
   * the bar-line container carries its alpha, the pitch lines bake theirs per
   * fill. `octaveDash` is `[on, off]` in px, or null for a solid rule.
   */
  grid: {
    colorExpr: string;
    barLineAlpha: number;
    /** Each beat inside a bar, fainter than the bar lines; 0 draws none. */
    beatLineAlpha: number;
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
/**
 * The Synthesia track palette: the first two sampled pixel-exact from
 * Synthesia (blue + green — its default right/left-hand colours), the rest
 * extending the set in the same vivid-but-soft register.
 */
const SYNTHESIA_TRACKS = [
  "#87aacf", // 1 — Synthesia blue
  "#a2e55b", // 2 — Synthesia green
  "#cf87c4", // 3 — magenta
  "#e5b15b", // 4 — amber
  "#5bd2cf", // 5 — cyan
  "#e58787", // 6 — rose
  "#9b87cf", // 7 — violet
  "#b6cf5b", // 8 — lime
  "#5b9be5", // 9 — azure
  "#e5cf5b", // 10 — gold
] as const;

const DIGITAL_ROLL: Omit<SonataLookStyle, "keys"> = {
  laneBg: "#262626",
  notes: { insetPx: 0.5, radiusPx: 4, accidentalShade: true },
  tracks: SYNTHESIA_TRACKS,
  nowLine: { colorExpr: "var(--primary)", alpha: 1 },
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
    beatLineAlpha: 0,
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
  // The immersive player's night (proto-1792113547-2qr6g7, `roll: immersive`):
  // the stage's blue-black, a rule at every bar and a fainter one at every
  // beat, a column rule at every C (stronger) and F, roomy rounded bars in one
  // colour per track whatever key they land on, ivory keys, and the sky accent
  // as the landing line at half strength.
  immersive: {
    laneBg: "#0d0d13",
    laneGrain: null,
    laneInk: "#f1efea",
    notes: { insetPx: 2.5, radiusPx: 5, accidentalShade: false },
    tracks: [
      "#5f8ff0", // 1 — blue
      "#a6e36b", // 2 — green
      "#c39bff", // 3 — lilac
      ...SYNTHESIA_TRACKS.slice(3),
    ],
    nowLine: { colorExpr: "var(--primary)", alpha: 0.55 },
    pen: DIGITAL_ROLL.pen,
    grid: {
      colorExpr: "#ffffff",
      barLineAlpha: 0.11,
      beatLineAlpha: 0.035,
      octaveLineAlpha: 0.12,
      pitchLineAlpha: 0.075,
      octaveDash: null,
    },
    labels: DIGITAL_ROLL.labels,
    keys: { skin: "immersive" },
  },

  flat: { ...DIGITAL_ROLL, keys: { skin: "flat" } },

  realistic: { ...DIGITAL_ROLL, keys: { skin: "realistic" } },

  // Cream paper, graphite pencil, ink. The lane grain is the prototype's
  // fractal-noise tile at half strength: the prototype composited it with
  // `multiply` at 0.5 opacity, and we paint it plain (no blend mode), so the
  // rect's own opacity absorbs that factor.
  sketch: {
    laneBg: "#f7f2e5",
    notes: { insetPx: 0.5, radiusPx: 4, accidentalShade: true },
    tracks: SYNTHESIA_TRACKS,
    nowLine: { colorExpr: "var(--primary)", alpha: 1 },
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
      beatLineAlpha: 0,
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
