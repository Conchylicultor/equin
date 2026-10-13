import {
  spaceLength,
  type SpaceStep,
} from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  type InTreeLayer,
  zLayerClass,
} from "@plugins/primitives/plugins/css/plugins/z-layers/web";
import type React from "react";

/**
 * Where the pinned child anchors inside its `relative` parent: a corner, an
 * edge-center, or dead center.
 */
export type PinAnchor =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "center";

/**
 * The four edge-center anchors — the only ones with a *perpendicular axis* to
 * say anything about. A corner pins both of its adjacent edges and `center`
 * pins neither, so `stretch` / `spanOffset` have no meaning on either; the
 * generic on {@link PinProps} makes them unspellable there rather than silently
 * ignored.
 */
export type PinEdgeAnchor = "top" | "bottom" | "left" | "right";

/**
 * A `SpaceStep` inset distance, negated for an `outset` (the badge that overhangs
 * its corner, `-top-1 -right-1`). The ramp declares no inset utilities, so — like
 * `sticky` — the distance is an inline style reading the density `--space-*` var.
 */
function edgeLength(step: SpaceStep, outset: boolean): string {
  const v = spaceLength(step);
  return outset && step !== "none" ? `calc(${v} * -1)` : v;
}

/**
 * The gradient ramp a masked pin dissolves the content it covers over. One fixed
 * distance, not a prop: the ramp is a legibility constant (long enough to read as
 * a fade rather than a cut, short enough not to eat the row), and a per-call-site
 * knob would only let sites drift.
 */
const SCRIM_FADE = "1.5rem";

/**
 * The paint of a masked pin: an opaque scrim in the covered surface's own color,
 * dissolved along whichever edges face INWARD (away from the ones it is anchored
 * to), so the content underneath fades out instead of being cut mid-glyph.
 *
 * The paint is `--scrim` LAYERED OVER `--chrome-mask` — the surface's published
 * background, with `--scrim` the TRANSIENT tint a surface paints over that
 * background (a hovered/selected row, an interactive card), republished so the
 * scrim matches what is actually on screen at reveal time. Layered, not
 * substituted: a tint is often a translucent overlay (`rgb(255 255 255 / 0.05)`
 * — a hover that lightens whatever it sits on), and painted alone it would let
 * the covered glyphs show through the icons. Over the opaque mask it is exactly
 * the row's composite colour; an opaque tint simply covers the mask. The tint is
 * an image layer (a flat `linear-gradient`) because a background has only one
 * colour layer. It is deliberately a second property rather than a `--chrome-mask`
 * re-declaration: a row's tint is a composite *over* the ambient mask
 * (`color-mix(… , var(--chrome-mask))`), and a property whose value reads itself
 * is a cycle CSS resolves to nothing. The `var(…, …)` fallback — never a `:root`
 * default — is also what keeps it correct inside a forked theme scope, for the
 * reason app.css documents for `--chrome-mask` itself.
 *
 * The offset is re-expressed as PADDING (the caller's `to`/`offset` still read as
 * "inset from that edge") because a scrim inset from the edge it hides against
 * leaves a sliver of live content showing in the gap. `borderRadius: inherit`
 * keeps it inside a rounded row/card's corners.
 */
function scrimDecor(to: PinAnchor, len: string): React.CSSProperties {
  const style: React.CSSProperties = {
    backgroundColor: "var(--chrome-mask)",
    backgroundImage:
      "linear-gradient(var(--scrim, transparent), var(--scrim, transparent))",
    borderRadius: "inherit",
  };
  const gradients: string[] = [];
  if (to.includes("right")) {
    gradients.push(
      `linear-gradient(to right, transparent, black ${SCRIM_FADE})`,
    );
    style.paddingRight = len;
    style.paddingLeft = `calc(${len} + ${SCRIM_FADE})`;
  }
  if (to.includes("left")) {
    gradients.push(
      `linear-gradient(to left, transparent, black ${SCRIM_FADE})`,
    );
    style.paddingLeft = len;
    style.paddingRight = `calc(${len} + ${SCRIM_FADE})`;
  }
  if (to.includes("top")) {
    gradients.push(`linear-gradient(to top, transparent, black ${SCRIM_FADE})`);
    style.paddingTop = len;
    style.paddingBottom = `calc(${len} + ${SCRIM_FADE})`;
  }
  if (to.includes("bottom")) {
    gradients.push(
      `linear-gradient(to bottom, transparent, black ${SCRIM_FADE})`,
    );
    style.paddingBottom = len;
    style.paddingTop = `calc(${len} + ${SCRIM_FADE})`;
  }
  if (gradients.length > 0) {
    const image = gradients.join(", ");
    style.maskImage = image;
    style.WebkitMaskImage = image;
    // Two ramps (a corner anchor) must BOTH hold — the scrim is opaque only where
    // neither edge is fading. Single-ramp masks composite identically either way.
    style.maskComposite = "intersect";
    style.WebkitMaskComposite = "source-in";
  }
  return style;
}

/**
 * Pure class + style map for a pinned child — single source of truth, exported
 * so the component and the pure test share one definition.
 *
 * `absolute` + the stacking layer are always classes. Per anchor:
 * - **corners** pin both adjacent edges via inline-style insets (no class).
 * - **edge-centers** pin that edge (inline style) and, on the perpendicular axis,
 *   either center it (`left-1/2 -translate-x-1/2` — pure Tailwind classes) or, when
 *   spanning it, pin BOTH of its edges via inline-style insets, `spanOffset` in
 *   from each.
 * - **center** is the four-class translate centering trick; `offset` is ignored.
 *
 * Every distance is an inline style — the anchored edges via {@link edgeLength},
 * the spanned axis via `spanOffset` — so the only classes left are `absolute`,
 * the z-layer, `pointer-events-none`, the mask's flex centering, and the
 * translate/`1/2` centering mechanics, which are pure Tailwind living inside this
 * exempt primitive so callers never write them.
 *
 * `spanOffset` **implies `stretch`**, exactly as `mask` does: an inset on an axis
 * that is not spanned would be a silent no-op, and there is no other reading of
 * asking for one. `outset` does **not** negate it — `outset` means "overhang the
 * edge you are anchored to", and the spanned axis has no anchor.
 *
 * `mask` layers the scrim on top (see {@link scrimDecor}) and changes three of the
 * mechanics, because a scrim that does not reach the edges it hides against is
 * not a scrim: the anchor insets collapse to `0` (the offset becomes padding), an
 * edge-center anchor spans its perpendicular axis — a hovered row's actions must
 * cover the row's whole height, not just the button cluster's box — with its
 * content centered on that axis exactly as the non-stretch anchor would place it,
 * and the span itself is forced flush to `0`. The span offset is *not*
 * re-expressed as padding the way `offset` is: a gap along the spanned axis is
 * precisely the live sliver `mask` exists to abolish.
 */
export function pinClasses(opts: {
  to: PinAnchor;
  offset: SpaceStep;
  outset: boolean;
  layer: InTreeLayer;
  decorative: boolean;
  stretch: boolean;
  spanOffset: SpaceStep;
  mask: boolean;
}): { className: string; style: React.CSSProperties } {
  const classes = ["absolute", zLayerClass(opts.layer)];
  if (opts.decorative) classes.push("pointer-events-none");
  const style: React.CSSProperties = {};
  const offsetLen = edgeLength(opts.offset, opts.outset);
  // A masked pin sits FLUSH against the edges it is anchored to and re-expresses
  // the offset as padding; an unmasked one keeps the offset as the inset it has
  // always been.
  const len = opts.mask ? "0" : offsetLen;
  // The spanned axis is never `outset` — there is no anchor on it to overhang —
  // and a masked pin spans flush, since a gap there is the sliver the scrim is
  // for. Asking for a span inset at all IS asking to span.
  const spanLen = opts.mask ? "0" : spaceLength(opts.spanOffset);
  const stretch = opts.stretch || opts.mask || opts.spanOffset !== "none";
  if (opts.mask) classes.push("flex items-center justify-center");

  switch (opts.to) {
    case "top-left":
      style.top = len;
      style.left = len;
      break;
    case "top-right":
      style.top = len;
      style.right = len;
      break;
    case "bottom-left":
      style.bottom = len;
      style.left = len;
      break;
    case "bottom-right":
      style.bottom = len;
      style.right = len;
      break;
    case "top":
      style.top = len;
      if (stretch) {
        style.left = spanLen;
        style.right = spanLen;
      } else classes.push("left-1/2 -translate-x-1/2");
      break;
    case "bottom":
      style.bottom = len;
      if (stretch) {
        style.left = spanLen;
        style.right = spanLen;
      } else classes.push("left-1/2 -translate-x-1/2");
      break;
    case "left":
      style.left = len;
      if (stretch) {
        style.top = spanLen;
        style.bottom = spanLen;
      } else classes.push("top-1/2 -translate-y-1/2");
      break;
    case "right":
      style.right = len;
      if (stretch) {
        style.top = spanLen;
        style.bottom = spanLen;
      } else classes.push("top-1/2 -translate-y-1/2");
      break;
    case "center":
      classes.push("top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2");
      break;
  }

  return {
    className: classes.join(" "),
    style: opts.mask ? { ...style, ...scrimDecor(opts.to, offsetLen) } : style,
  };
}

/**
 * `T` is the anchor the caller actually wrote, so the two perpendicular-axis
 * props can be typed *per anchor*: on a corner or `center` they resolve to
 * `never` and are a compile error rather than a silently-ignored prop.
 *
 * It is a naked type parameter on purpose, so each conditional **distributes**
 * over a union: `<Pin to={anchor}>` where `anchor: PinAnchor` yields
 * `SpaceStep | never` = `SpaceStep`, and stays as usable as it is today. A
 * discriminated props union would not — it cannot accept a union-typed
 * discriminant at all.
 */
export interface PinProps<
  T extends PinAnchor = PinAnchor,
> extends React.HTMLAttributes<HTMLElement> {
  /** Where to anchor inside the `relative` parent. Required. */
  to: T;
  /** Inset from the anchored edge(s), from the spacing ramp. Default `none`.
   *  Ignored for `to="center"`. */
  offset?: SpaceStep;
  /** Negate the offset so the child overhangs the corner/edge (a badge that pokes
   *  out, `-top-1 -right-1`). Default false. */
  outset?: boolean;
  /** Stacking level among siblings, from the z-layer scale. Default `raised`. */
  layer?: InTreeLayer;
  /** Make the child click-through (`pointer-events-none`) — a decorative overlay
   *  that must never eat clicks. Default false. */
  decorative?: boolean;
  /** Span the perpendicular axis full-length (both its edges pinned at `0`)
   *  instead of centering on it. Default false. Edge-center anchors only — a
   *  corner or `center` has no perpendicular axis, so it is a type error there.
   *  Implied by `mask` and by `spanOffset`. */
  stretch?: T extends PinEdgeAnchor ? boolean : never;
  /** Inset the spanned axis from both of its edges, from the spacing ramp — the
   *  full-bleed drag indicator that stops short of the row's corners. Default
   *  `none` (flush).
   *
   *  **Implies `stretch`**: an inset on an axis that is not spanned would be a
   *  silent no-op, and there is no other reading of asking for one. `outset`
   *  does NOT negate it — `outset` overhangs the edge you are *anchored* to, and
   *  the spanned axis has no anchor. `mask` forces it back to `0`, since a gap
   *  along the spanned axis is exactly the live sliver the scrim is there to
   *  cover (and unlike `offset`, it is not re-expressed as padding).
   *
   *  Edge-center anchors only, for the same reason as `stretch`. */
  spanOffset?: T extends PinEdgeAnchor ? SpaceStep : never;
  /**
   * Paint the scrim — an opaque backdrop in the covered surface's own color
   * (the `--scrim` tint layered over the surface's `--chrome-mask`), dissolved along
   * the pin's inward-facing edges so the content it covers fades out instead of
   * showing through the child. Default false.
   *
   * This is the point-anchored twin of `<Sticky mask>`: an overlay that hides
   * content must paint what is behind it. **Any pin that overlays live content —
   * a row's hover-revealed actions, a card's corner affordances — needs it**; a
   * transparent one puts icons on top of legible text (glyphs interleaving with
   * glyphs), which is a defect, not a style. Pins over inert space (a status dot
   * on an avatar, a drag indicator, a badge on an icon) do not.
   *
   * A masked pin sits flush against its anchored edges — the `offset` becomes the
   * child's padding, so the scrim leaves no live sliver at the edge — and an
   * edge-center anchor spans its perpendicular axis (implies `stretch`).
   */
  mask?: boolean;
  /** Host element/component. Defaults to a `div`. */
  as?: React.ElementType;
  /** Forwarded to the rendered element (mirrors Surface/Card/Row). */
  ref?: React.Ref<HTMLElement>;
}

/**
 * The sanctioned point-anchored absolute-positioning primitive — places a child
 * at a corner / edge-center / center of a caller-owned `relative` parent, the
 * `absolute top-1 right-1` family ~150 call sites wrote by hand.
 *
 * Sibling of `<Overlay>`, NOT an extension of it: Overlay stays pristine
 * (full-bleed `inset-0` layers only); Pin is the *point* anchor. The parent must
 * establish the positioning context (`relative` is not banned) — Pin only places
 * itself within it.
 *
 * Use Pin only for offsets expressible on the semantic ramp. JS/pixel/fractional
 * coordinates (drag handles, canvas overlays, floating-UI popovers) are NOT this
 * primitive's job — those keep a per-site `// eslint-disable -- reason`.
 *
 * Caller `className` composes last; caller `style` overrides the anchor insets.
 */
export function Pin<T extends PinAnchor>({
  to,
  offset = "none",
  outset = false,
  layer = "raised",
  decorative = false,
  stretch,
  spanOffset,
  mask = false,
  as: As = "div",
  ref,
  className,
  style,
  children,
  ...rest
}: PinProps<T>) {
  const pin = pinClasses({
    to,
    offset,
    outset,
    layer,
    decorative,
    // The two per-anchor props carry a deferred conditional type while `T` is
    // unresolved, so their defaults are applied here rather than in the
    // destructuring — `false` is not assignable to `T extends … ? boolean : never`.
    stretch: Boolean(stretch),
    spanOffset: spanOffset ?? "none",
    mask,
  });
  return (
    <As
      ref={ref}
      className={cn(pin.className, className)}
      style={{ ...pin.style, ...style }}
      {...rest}
    >
      {children}
    </As>
  );
}
