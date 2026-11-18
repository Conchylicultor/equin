import { Fragment, useId, useMemo } from "react";
import type { SonataDrawnKeys } from "@plugins/apps/plugins/sonata/plugins/look/core";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import type { PitchKey } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { litKeyColor, mix } from "./key-color";
import {
  clamp,
  drawnKeyPath,
  drawnLine,
  sketchMetrics,
  type SketchMetrics,
} from "./sketch-paths";

/**
 * The hand-drawn key skin — a decorative SVG layer painted UNDER the keyboard's
 * real key divs, which stay in place as transparent hit targets and label hosts
 * (the same layering `BLACK_FACE` already uses). Nothing here is interactive:
 * the whole layer is `pointer-events-none`, so `usePlayableKeyboard`'s
 * `data-pitch` hit test never sees it and glissando / multi-touch are unaffected.
 *
 * WHY AN SVG AT ALL. The other two skins are CSS gradients on the key divs,
 * which is fine for bevels and useless for an irregular outline — a drawn key
 * has bowed edges and uneven corners, and no box can have those. So the drawn
 * look leaves the divs entirely transparent and paints the keys as paths.
 *
 * ONE `<svg>` PER GROUP, not per key: a single `<defs>` of shading gradients is
 * referenced by all 52 whites or all 36 blacks, so a key costs a handful of
 * paths and nothing else — no per-key svg, no per-key gradient.
 *
 * MEASURED PIXELS, NOT A UNIT BOX. The keys are percentage-positioned divs, but
 * a 0..1 viewBox stretched with `preserveAspectRatio="none"` would scale the
 * wobble and the stroke widths by the (wildly non-uniform) key aspect ratio —
 * horizontal pen strokes would come out fat and vertical ones thin. So the layer
 * measures its own box and builds the viewBox in real px.
 *
 * DEPTH COMES FROM SHADE, NOT BEVELS. A graphite wash down the front of each
 * ivory, a blurred cast shadow where each ebony meets the white beside it, a
 * sheen down the black, and the outline drawn twice, slightly off — SVG has no
 * per-length stroke width, so that overdraw IS the pen pressure.
 *
 * LIGHTING A KEY REWRITES `fill`, NEVER `d`. Every path string is memoized on
 * the geometry alone; the lit tint is a permanently-mounted overlay path whose
 * fill flips between a colour and `none`. A note-on therefore costs one style
 * write per key, with no path re-generation and no element churn.
 */

/** The pen weights of the prototype, at its own key height. Scaled per render
 *  by {@link SketchMetrics.scale} so a readout chip is drawn with a lighter
 *  hand rather than the same absolute line shrunk into mush. */
const PEN = {
  whiteStroke: 1.5,
  ghostStroke: 0.75,
  blackStroke: 1.2,
  ruleStroke: 1.3,
  /** Cast-shadow blur and how far the ebony's shadow falls onto the ivory. */
  shadowBlur: 2.4,
  shadowOffset: 1,
  shadowOvershoot: 5,
  whiteTopRadius: 1.5,
  whiteBottomRadius: 4.5,
  blackTopRadius: 1.2,
  blackBottomRadius: 3,
} as const;

/** The second pass over an outline is the same key drawn again by a hand that
 *  cannot land on its own line. Offsetting the seed is what makes it a
 *  different squiggle instead of an exact retrace. */
const OVERDRAW_SEED_OFFSET = 977;

/** How much of the ivory a lit key's tint covers, and the (higher) share it
 *  takes on an ebony — a dark key needs more colour to read as lit at all. */
const WHITE_TINT_PCT = 80;
const BLACK_TINT_PCT = 88;

/** One key's drawn geometry: everything that depends on the box, and nothing
 *  that depends on whether it is lit. */
interface KeyArt {
  pitch: number;
  /** The key outline, filled and stroked. */
  d: string;
  /** The overdrawn second outline (whites only — an ebony's crease reads better
   *  as one clean line). */
  ghostD: string | null;
  /** The blurred rect an ebony casts onto the ivory beside it. */
  shadow: { x: number; y: number; width: number; height: number } | null;
}

interface SketchArt {
  keys: KeyArt[];
  /** The loose rule the keys hang from, in place of the felt strip. */
  rule: string | null;
  metrics: SketchMetrics;
}

/**
 * Map the fractional key pads onto the measured box. Ivories span the full
 * height and tile edge-to-edge (a half-pixel inset each side keeps neighbours
 * from sharing one drawn edge); an ebony takes the box the PAD declares and
 * tapers toward the player, which is what stops it reading as a bar stuck on top
 * of the ivory.
 *
 * Every extent comes from the pad itself (`top`/`height` as fractions of the
 * keybed), so the drawn art can no longer disagree with the div that hit-tests
 * for it — there is no second copy of the black key's 62% here to drift. The
 * x/width arithmetic is deliberately the same expression the key divs use in
 * `keyboard.tsx`, for the same reason.
 */
function buildSketchArt(
  lanes: readonly PitchKey[],
  accidental: boolean,
  width: number,
  height: number,
): SketchArt {
  const metrics = sketchMetrics(height);
  const { amp, scale } = metrics;
  const black = accidental;

  const keys = lanes.map((k): KeyArt => {
    const laneX = (k.center - k.width / 2) * width;
    const laneW = k.width * width;
    const laneY = k.top * height;
    const laneH = k.height * height;

    if (black) {
      const taper = laneW * 0.08;
      const box = {
        x: laneX + taper * 0.5,
        y: laneY,
        width: laneW - taper,
        height: laneH,
      };
      return {
        pitch: k.pitch,
        d: drawnKeyPath({
          ...box,
          seed: k.pitch,
          amp: amp * 0.85,
          topRadius: PEN.blackTopRadius * scale,
          bottomRadius: clamp(
            PEN.blackBottomRadius * scale,
            0,
            box.width * 0.3,
          ),
        }),
        ghostD: null,
        shadow: {
          x: box.x + PEN.shadowOffset * scale,
          y: box.y,
          width: box.width,
          height: box.height + PEN.shadowOvershoot * scale,
        },
      };
    }

    const inset = 0.5 * scale;
    const box = {
      x: laneX + inset,
      y: laneY,
      width: laneW - inset * 2,
      height: laneH,
    };
    const shape = {
      topRadius: PEN.whiteTopRadius * scale,
      bottomRadius: clamp(PEN.whiteBottomRadius * scale, 0, box.width * 0.3),
    };
    return {
      pitch: k.pitch,
      d: drawnKeyPath({ ...box, ...shape, seed: k.pitch, amp }),
      ghostD: drawnKeyPath({
        ...box,
        ...shape,
        seed: k.pitch + OVERDRAW_SEED_OFFSET,
        amp: amp * 0.7,
      }),
      shadow: null,
    };
  });

  // The rule belongs to the black pass so it draws over the top edge of both
  // tiers — the keys hang from it, exactly as in the prototype.
  const ruleY = (PEN.ruleStroke * scale) / 2;
  return {
    keys,
    rule: black ? drawnLine(0, width, ruleY, 1, 1.2 * scale) : null,
    metrics,
  };
}

export interface SketchKeysProps {
  /**
   * The pads of ONE tier, already filtered. Pass a memoized array: the path
   * strings are memoized on it, and a fresh array every render would rebuild
   * every key's geometry on every note-on.
   */
  lanes: readonly PitchKey[];
  /**
   * Which pen this pass draws with — ebony or ivory. It is the pad's PITCH
   * CLASS, not its tier: the tier is the primitive's paint order and says
   * nothing about what a key is made of.
   */
  accidental: boolean;
  /** The drawn look's key palette (`SONATA_LOOK_STYLES[look].keys`, narrowed to
   *  its drawn arm by the caller — this layer only ever mounts under it). */
  palette: SonataDrawnKeys;
  /** Pitch → lit colour, in the raw form `Keyboard` normalises to (an empty
   *  string means the theme accent — see {@link litKeyColor}). */
  litColors: ReadonlyMap<number, string>;
}

/**
 * One tier's drawn keys. Mount it as a sibling immediately BEFORE that tier's
 * key divs, so the divs (transparent under this look) stay on top as hit targets
 * and label hosts.
 */
export function SketchKeys({
  lanes,
  accidental,
  palette,
  litColors,
}: SketchKeysProps) {
  // Attach the ref to the layer itself and measure it: it is `inset-0` over the
  // keyboard's own box, so its size IS the keyboard's size — no reaching for a
  // parent, and no measurement at all under the other two skins, which never
  // mount this component.
  const [boxRef, { width, height }] = useElementSize((s) => s);

  // `useId` is per component instance, so two keyboards on one page (the roll
  // and a readout chip) never collide on a gradient id. Its React-generated ids
  // carry punctuation, which a fragment reference tolerates but a selector does
  // not — strip it and stay boring.
  const uid = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-${accidental ? "ebony" : "ivory"}`;
  const shadeId = `${uid}-shade`;
  const softId = `${uid}-soft`;

  const art = useMemo(
    () => buildSketchArt(lanes, accidental, width, height),
    [lanes, accidental, width, height],
  );

  const { shade } = palette;
  const { scale } = art.metrics;
  const black = accidental;
  // Both derived from the palette's own ink rather than being two more fixed
  // hexes: the crease down an ebony has to be darker than the key it creases,
  // and the rule is a lighter pencil than the outlines.
  const ebonyStroke = `color-mix(in srgb, ${palette.ebony} 75%, #000)`;
  const ruleStroke = `color-mix(in srgb, ${palette.ink} 80%, ${palette.ivory})`;

  return (
    <Layer ref={boxRef} decorative aria-hidden>
      {width > 0 && height > 0 && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <defs>
            {black ? (
              <>
                {/* Sheen catching the light at the far end, shading into the
                    front — the ebony's own depth, no bevel involved. */}
                <linearGradient id={shadeId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#fff" stopOpacity={0.2 * shade} />
                  <stop
                    offset="0.35"
                    stopColor="#fff"
                    stopOpacity={0.05 * shade}
                  />
                  <stop offset="1" stopColor="#000" stopOpacity={0.3 * shade} />
                </linearGradient>
                <filter
                  id={softId}
                  x="-40%"
                  y="-20%"
                  width="180%"
                  height="160%"
                >
                  <feGaussianBlur stdDeviation={PEN.shadowBlur * scale} />
                </filter>
              </>
            ) : (
              /* Graphite wash: darker where the key tucks under the fallboard,
                 clear through the middle, darkening again into the front lip. */
              <linearGradient id={shadeId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#000" stopOpacity={0.13 * shade} />
                <stop
                  offset="0.16"
                  stopColor="#000"
                  stopOpacity={0.03 * shade}
                />
                <stop offset="0.82" stopColor="#000" stopOpacity="0" />
                <stop offset="1" stopColor="#000" stopOpacity={0.16 * shade} />
              </linearGradient>
            )}
          </defs>

          {art.keys.map((key) => {
            const lit = litKeyColor(litColors.get(key.pitch));
            // A lit ebony takes the SAME base colour a lit ivory does, not the
            // darker accidental shade the flat skin uses: this skin builds its
            // own darkness from the sheen gradient painted over the tint, so
            // pre-darkening would compound (the realistic skin reasons
            // identically about its gradient).
            const tint =
              lit === undefined
                ? "none"
                : mix(lit, black ? BLACK_TINT_PCT : WHITE_TINT_PCT);
            return (
              <Fragment key={key.pitch}>
                {key.shadow && shade > 0 && (
                  <rect
                    {...key.shadow}
                    opacity={0.13 * shade}
                    filter={`url(#${softId})`}
                    style={{ fill: "#000" }}
                  />
                )}
                <path
                  d={key.d}
                  strokeWidth={
                    (black ? PEN.blackStroke : PEN.whiteStroke) * scale
                  }
                  strokeLinejoin="round"
                  style={{
                    fill: black ? palette.ebony : palette.ivory,
                    stroke: black ? ebonyStroke : palette.ink,
                  }}
                />
                {/* Lit tint — mounted at rest too (fill `none`), so a note-on
                    is one style write and never an element insert. It sits
                    UNDER the shading, which is what keeps a lit key looking
                    like a key rather than a flat coloured slab. */}
                <path d={key.d} style={{ fill: tint }} />
                <path d={key.d} style={{ fill: `url(#${shadeId})` }} />
                {key.ghostD && (
                  <path
                    d={key.ghostD}
                    strokeWidth={PEN.ghostStroke * scale}
                    strokeOpacity={0.5}
                    strokeLinejoin="round"
                    style={{ fill: "none", stroke: palette.ink }}
                  />
                )}
              </Fragment>
            );
          })}

          {art.rule && (
            <path
              d={art.rule}
              strokeWidth={PEN.ruleStroke * scale}
              style={{ fill: "none", stroke: ruleStroke }}
            />
          )}
        </svg>
      )}
    </Layer>
  );
}
