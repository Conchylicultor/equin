import type { CSSProperties } from "react";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import type { SonataKeys } from "@plugins/apps/plugins/sonata/plugins/look/core";
import {
  isAccidental,
  type PitchKey,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { mix } from "../key-color";
import { SketchKeys } from "../sketch-skin";
import type {
  ChromeDecor,
  ChromeDecorContext,
  KeyChrome,
  KeyChromeStyle,
  KeyPaint,
  KeyPaintContext,
  KeyTier,
} from "./types";

/**
 * The piano chrome — ivory naturals tiling the keybed, ebony accidentals riding
 * the boundaries above them.
 *
 * Key colors. A piano is a physical object — white keys are always ivory,
 * black keys always near-black, the keybed felt always deep red — so every
 * surface color here stays fixed in both light and dark themes rather than
 * tracking the UI's foreground/background tokens (which flip in dark mode and
 * would invert the keys). The lit state tints the key with the theme's accent
 * (`var(--primary)`) or a caller-supplied color via `color-mix()`, layered
 * over the fixed key chrome. Inline styles keep all of this out of the
 * className-only `no-hardcoded-colors` check (the sanctioned escape hatch for
 * physical-object colors).
 *
 * FOUR skins, applied to EVERY keyboard render (full roll + readout chips),
 * and all four come from ONE switch — Sonata's look:
 *  - `immersive` — the night keybed: warm ivory naturals on a near-black bed
 *    (a 1px seam between keys), cool dark accidentals, and a lit key painted
 *    in the note's actual colour.
 *  - `realistic` — skeuomorphic ivory/ebony: gradients + box-shadow bevels, a
 *    pressed-key depression, and a lit key tinted (translucent) over the ivory.
 *  - `flat` — Synthesia-style: solid fills, no gloss/gradients, strong dark
 *    white-key borders, and a lit key painted in the note's ACTUAL color (the
 *    same color it fell in — no translucent tint washing it out).
 *  - `drawn` — the sketch look's hand-drawn keys, an SVG layer
 *    (`sketch-skin.tsx`); here it only means the key divs go transparent and the
 *    felt strip stands down.
 *
 * There is no second axis to reconcile. The keys used to have their own
 * flat/realistic config alongside the look, but the drawn look never consulted
 * it — paper lane under glossy ivory keys is not a combination worth reaching —
 * so the pair was really one three-valued choice wearing two controls. The skin
 * is now read straight off the look's palette, which is why the unwanted
 * combination has no spelling rather than a rule that suppresses it.
 *
 * Realism (realistic variant) is pure CSS — gradients + box-shadows only,
 * expressed in percentages and 1–2px values so the same chrome scales from a
 * readout chip to the full 88-key roll gutter. Layers, back to front:
 * white keys → red felt strip → black keys.
 */

/** Shared press transition — fast enough to track per-frame note onsets. */
const PRESS_TRANSITION = "transform 80ms ease-out, box-shadow 80ms ease-out";

/**
 * Fixed bottom-corner radius for the keys. A piano key's front lip is only
 * barely eased on a real instrument — far squarer than the UI's `--radius`
 * shape token. Like the fixed key colors above, this is a physical-object
 * shape that must NOT track the app's shape preset (a "Pill" theme should not
 * round piano keys into lozenges), so it lives in an inline style rather than a
 * `rounded-*` token class. The keys' top edge stays square (it tucks under the
 * felt/fallboard).
 */
const KEY_BOTTOM_RADIUS = {
  borderBottomLeftRadius: "3.5px",
  borderBottomRightRadius: "3.5px",
} satisfies KeyChromeStyle;

/* ---- Immersive variant -------------------------------------------------- *
 * The player's night keybed (proto-1792113547-2qr6g7): warm ivory naturals with
 * a soft shade at the top edge, separated by a 1px seam of the near-black bed;
 * accidentals a cool dark gradient. A lit key is painted in the note's actual
 * colour, as under `flat`. */
const IMMERSIVE_BED = "#08080c";
const IMMERSIVE_WHITE_BG =
  "linear-gradient(to bottom, #d9d4ca, #f2efe9 10%, #e4dfd6)";
const IMMERSIVE_BLACK_BG = "linear-gradient(to bottom, #15151b, #30303a)";
const IMMERSIVE_SEAM = `inset -1px 0 0 ${IMMERSIVE_BED}`;

/**
 * Red felt strip at the top of the keybed — the dampening felt visible where
 * the keys meet the fallboard on a real piano. Flat keeps the line as a solid
 * red bar (Synthesia shows the same strike line) without the gloss shadow.
 */
const FELT_REALISTIC: CSSProperties = {
  height: "2px",
  background: "linear-gradient(to bottom, #5e1620, #7a1f2b)",
  boxShadow: "0 1px 1px rgba(0, 0, 0, 0.25)",
};
const FELT_FLAT: CSSProperties = { height: "2px", background: "#7a1f2b" };
/** The immersive keybed shows a dark seam where the felt would be: the stage's
 *  black between the landing line and the keys. */
const FELT_IMMERSIVE: CSSProperties = {
  height: "2px",
  background: IMMERSIVE_BED,
};
const feltStyle = (style: Exclude<KeySkin, "drawn">): CSSProperties =>
  style === "flat"
    ? FELT_FLAT
    : style === "immersive"
      ? FELT_IMMERSIVE
      : FELT_REALISTIC;

/**
 * Which skin draws the keys — the look's own three-member choice, aliased here
 * so every per-key style function has to answer for all of them and `tsc` says
 * so if a fourth look introduces a new one.
 */
type KeySkin = SonataKeys["skin"];

/**
 * Under the drawn skin the key div holds no chrome at all: `sketch-skin.tsx`
 * paints the key as a path beneath it, and the div stays purely as the
 * `data-pitch` hit target and the host for `renderKey` labels. Transparent, not
 * absent — removing it would take glissando and multi-touch with it.
 */
const DRAWN_CHROME: KeyChromeStyle = { background: "transparent" };

/* ---- Realistic variant -------------------------------------------------- */

/**
 * White key: ivory sheen from the top, with the last ~8% darkening into the
 * rounded front edge (the lip facing the player). Inset shadows carve the
 * inter-key groove (right edge), a soft left-edge highlight, and the bottom
 * lip. When lit, the front-edge gradient stops compress (88/94 → 91/97) so
 * less of the lip is visible — the depression read — and a tint gradient
 * (strong at the top, still saturated enough at the bottom for label
 * contrast) layers over the ivory. The leading zero-size outer shadow at rest
 * keeps the shadow lists structurally parallel so the glow interpolates
 * instead of jumping.
 */
const WHITE_REST_BG =
  "linear-gradient(to bottom, #fdfdfa, #f7f6f1 55%, #efeee8 88%, #dddcd4 94%, #cfcec6)";
const WHITE_PRESSED_BG =
  "linear-gradient(to bottom, #fdfdfa, #f7f6f1 55%, #efeee8 91%, #dddcd4 97%, #cfcec6)";
const WHITE_CARVE =
  "inset -1px 0 0 #d9d8d0, inset 1px 0 0 rgba(255, 255, 255, 0.6), inset 0 -1px 1px rgba(0, 0, 0, 0.12)";

/**
 * Black key: glossy cap catching light at the far (top) end, side bevels via
 * inset shadows (left highlight, right shade), and a small drop shadow cast
 * onto the white keys below. The vertical front face of the key is a separate
 * pinned div (see `BLACK_FACE`). When lit, the cap is tinted via `color-mix`
 * over the gloss and the key gains the same press + glow.
 */
const BLACK_REST_BG =
  "linear-gradient(to bottom, #4a4a4a, #222222 18%, #161616 70%, #060606)";
const BLACK_CARVE =
  "inset 1px 0 0 rgba(255, 255, 255, 0.10), inset -1px 0 0 rgba(0, 0, 0, 0.70), inset 0 1px 0 rgba(255, 255, 255, 0.08)";
const BLACK_DROP = "0 2px 3px rgba(0, 0, 0, 0.45)";

/* ---- Flat (Synthesia) variant ------------------------------------------- *
 * Solid fills only — no gradients, gloss, or pressed depression. White keys
 * get a strong dark border on every edge (the inter-key separators read as
 * crisp dark lines, the front lip slightly darker). A lit key is painted in
 * the note's actual color, so the key matches the falling note exactly with no
 * translucent tint over ivory. */
const FLAT_WHITE_BG = "#fafafa";
const FLAT_WHITE_BORDER = "#52525b"; // inter-key separators (dark, strong)
const FLAT_WHITE_LIP = "#3f3f46"; // front bottom lip — slightly darker
const FLAT_BLACK_BG = "#1a1a1a";

/**
 * Flat white-key borders, drawn with inset box-shadows so they never shift
 * layout. Every key carries its right separator and bottom lip; only the
 * leftmost key adds a left edge (adjacent keys would otherwise double the line
 * between them), which also closes the keyboard's outer-left border.
 */
function flatWhiteCarve(isFirst: boolean): string {
  const edges = [
    `inset -1px 0 0 ${FLAT_WHITE_BORDER}`,
    `inset 0 -2px 0 ${FLAT_WHITE_LIP}`,
  ];
  if (isFirst) edges.push(`inset 1px 0 0 ${FLAT_WHITE_BORDER}`);
  return edges.join(", ");
}

function whiteKeyStyle(
  litColor: string | undefined,
  style: KeySkin,
  isFirst: boolean,
): KeyChromeStyle {
  if (style === "drawn") return DRAWN_CHROME;
  if (style === "immersive") {
    return {
      background: litColor ?? IMMERSIVE_WHITE_BG,
      boxShadow: IMMERSIVE_SEAM,
      transition: PRESS_TRANSITION,
    };
  }
  if (style === "flat") {
    return {
      background: litColor ?? FLAT_WHITE_BG,
      boxShadow: flatWhiteCarve(isFirst),
      transition: PRESS_TRANSITION,
    };
  }
  if (litColor === undefined) {
    return {
      background: WHITE_REST_BG,
      boxShadow: `0 0 0 0 rgba(0, 0, 0, 0), ${WHITE_CARVE}`,
      transition: PRESS_TRANSITION,
    };
  }
  const tint = `linear-gradient(to bottom, ${mix(litColor, 90)}, ${mix(litColor, 70)} 55%, ${mix(litColor, 55)})`;
  return {
    background: `${tint}, ${WHITE_PRESSED_BG}`,
    boxShadow: `0 0 6px 1px ${mix(litColor, 35)}, ${WHITE_CARVE}`,
    transform: "translateY(1px)",
    transition: PRESS_TRANSITION,
  };
}

/**
 * The black key's height used to be written here as a hardcoded `62%`, one of
 * two places that number lived. It is now the pad's own `height` and nothing
 * else — {@link KeyChromeStyle} does not carry the property, so the duplicate
 * cannot come back.
 */
function blackKeyStyle(
  litColor: string | undefined,
  style: KeySkin,
): KeyChromeStyle {
  const base: KeyChromeStyle = { transition: PRESS_TRANSITION };
  if (style === "drawn") return { ...base, ...DRAWN_CHROME };
  if (style === "flat") {
    return { ...base, background: litColor ?? FLAT_BLACK_BG };
  }
  if (style === "immersive") {
    return { ...base, background: litColor ?? IMMERSIVE_BLACK_BG };
  }
  if (litColor === undefined) {
    return {
      ...base,
      background: BLACK_REST_BG,
      boxShadow: `0 0 0 0 rgba(0, 0, 0, 0), ${BLACK_DROP}, ${BLACK_CARVE}`,
    };
  }
  return {
    ...base,
    background: `linear-gradient(to bottom, color-mix(in srgb, ${litColor} 72%, #3f3f3f), color-mix(in srgb, ${litColor} 60%, #161616) 35%, color-mix(in srgb, ${litColor} 48%, #060606))`,
    boxShadow: `0 0 6px 1px ${mix(litColor, 45)}, ${BLACK_DROP}, ${BLACK_CARVE}`,
    transform: "translateY(1px)",
    transition: PRESS_TRANSITION,
  };
}

/**
 * The black key's vertical front face — the surface facing the player at the
 * key's bottom (near) end. REALISTIC ONLY: it's a skeuomorphic depth cue (a
 * lighter lip that shortens 14% → 8% on press for the forward-tilt read). The
 * flat / Synthesia style draws each black key as a single uniform solid block,
 * so it gets no face — a darker foot band would read as an artifact against the
 * flat fill.
 *
 * It is `paint.children`, pinned to the key's own bottom edge, so it never
 * displaces the label and always paints BEHIND it: the primitive appends the
 * label after the chrome's children, and the key box is an `isolate` stacking
 * context, so DOM order alone settles the two. (It used to need `z-index: -1`
 * to stay behind an in-flow label.)
 */
const BLACK_FACE = (litColor: string | undefined): CSSProperties => ({
  height: litColor === undefined ? "14%" : "8%",
  background:
    litColor === undefined
      ? "linear-gradient(to bottom, #2e2e2e, #000000)"
      : `linear-gradient(to bottom, color-mix(in srgb, ${litColor} 48%, #060606), color-mix(in srgb, ${litColor} 28%, #000000))`,
  transition: "height 80ms ease-out, background 80ms ease-out",
});

/** Stable identity: the drawn skin memoizes its path strings on the array it is
 *  handed, so the empty case must be one array rather than a fresh `[]`. */
const EMPTY_KEYS: readonly PitchKey[] = Object.freeze([]);

/** The keys of one tier, or nothing when that tier is not on the plane (a
 *  two-octave chip window can hold no accidentals at all). */
function tierKeys(
  tiers: readonly KeyTier[],
  tier: number,
): readonly PitchKey[] {
  return tiers.find((t) => t.tier === tier)?.keys ?? EMPTY_KEYS;
}

export const pianoChrome: KeyChrome = {
  paintKey(key, lit, ctx: KeyPaintContext): KeyPaint {
    const skin = ctx.skin.skin;
    if (!isAccidental(key.pitch)) {
      // Only the first key of the tier draws its own left edge — see
      // `flatWhiteCarve`. It is the tier index rather than a remembered pitch,
      // so the rule holds for any window the caller asks for.
      return {
        style: {
          ...whiteKeyStyle(lit?.color, skin, ctx.indexInTier === 0),
          ...KEY_BOTTOM_RADIUS,
        },
      };
    }
    // A lit black key takes the darker accidental shade in the flat style (where
    // the key IS the fill color); realistic and drawn build their own darkness
    // from a gradient over near-black, so they keep the base color — darkening
    // first would compound.
    const litColor = skin === "flat" ? lit?.accidental : lit?.color;
    const style: KeyChromeStyle = {
      ...blackKeyStyle(litColor, skin),
      ...KEY_BOTTOM_RADIUS,
    };
    if (skin !== "realistic") return { style };
    return {
      style,
      children: (
        <Pin
          to="bottom"
          stretch
          decorative
          aria-hidden
          style={{ ...BLACK_FACE(litColor), ...KEY_BOTTOM_RADIUS }}
        />
      ),
    };
  },

  decor({
    tiers,
    skin,
    litColors,
  }: ChromeDecorContext): readonly ChromeDecor[] {
    // The drawn skin paints each group's keys AS DRAWN immediately beneath that
    // group's own divs, which carry no chrome under this look.
    if (skin.skin === "drawn") {
      return [
        {
          id: "sketch-white",
          tier: 0,
          node: (
            <SketchKeys
              lanes={tierKeys(tiers, 0)}
              accidental={false}
              palette={skin}
              litColors={litColors}
            />
          ),
        },
        {
          id: "sketch-black",
          tier: 1,
          node: (
            <SketchKeys
              lanes={tierKeys(tiers, 1)}
              accidental
              palette={skin}
              litColors={litColors}
            />
          ),
        },
      ];
    }
    // Red felt strip across the keybed top — above the naturals, below the
    // accidentals, which is exactly "before tier 1". `decorative` makes it
    // pointer-events-none, so playable-keyboard hit-tests fall through to the
    // key beneath it. `layer="base"` because the keys stack by DOM order alone:
    // Pin's default `raised` layer would lift the felt over the accidentals
    // painted after it, and their tops would show a red bar. The drawn skin has
    // no felt: it draws a pencil rule in the same place instead (a red bar
    // across a pencil drawing reads as a sticker).
    return [
      {
        id: "felt",
        tier: 1,
        node: (
          <Pin
            to="top"
            stretch
            decorative
            aria-hidden
            layer="base"
            style={feltStyle(skin.skin)}
          />
        ),
      },
    ];
  },

  labelTone(key) {
    return isAccidental(key.pitch) ? "on-dark" : "on-light";
  },
};
