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

/** Which edge of the scroll container the element sticks to. */
export type StickyEdge = "top" | "bottom" | "left" | "right";

/**
 * Pure class + style map for a sticky element — single source of truth, exported
 * so the component and the pure test share one definition. The position type and
 * stacking level are classes; the edge offset distance is an inline style (no
 * inset utility exists for the semantic ramp).
 */
export function stickyClasses(opts: {
  edge: StickyEdge;
  offset: SpaceStep;
  layer: InTreeLayer;
}): { className: string; style: React.CSSProperties } {
  const len = spaceLength(opts.offset);
  const style: React.CSSProperties =
    opts.edge === "top"
      ? { top: len }
      : opts.edge === "bottom"
        ? { bottom: len }
        : opts.edge === "left"
          ? { left: len }
          : { right: len };
  return { className: `sticky ${zLayerClass(opts.layer)}`, style };
}

export interface StickyProps extends React.HTMLAttributes<HTMLElement> {
  /**
   * Whether sticky positioning is applied. When `false` the element renders in
   * normal flow (no `position`/offset/z-layer) — but as the SAME element, so
   * toggling stickiness never changes element identity and therefore never
   * remounts children (which would reset their state). Defaults to `true`.
   */
  active?: boolean;
  /** Which scroll edge to pin to. Defaults to `top`. */
  edge?: StickyEdge;
  /** Inset from the pinned edge, from the spacing ramp. Defaults to `none`
   *  (flush — `top-0` / `bottom-0` / …). */
  offset?: SpaceStep;
  /** Stacking level among siblings, from the z-layer scale. Defaults to `raised`
   *  (a sticky header sits above the content it scrolls over). */
  layer?: InTreeLayer;
  /**
   * Paint the sticky-chrome mask (`bg-chrome-mask`) so scrolled content can't
   * show through the pinned bar. Prefer this over a hand-written `bg-background`:
   * the mask resolves to `--chrome-mask`, which follows the surface the bar is
   * pinned inside (page canvas by default, `--sidebar` in the sidebar, a
   * `<Surface>`'s own color when nested in one) — so an opaque header never
   * becomes a mismatched band in a tinted surface. `className` still composes
   * last, so a caller can override the color for a bespoke case. Defaults off.
   *
   * `"glass"` frosts instead: the same `--chrome-mask` at 72%, with the content
   * under the bar blurred, so what scrolls beneath still tints it (a page whose
   * content is a picture, not a document — the website's iceberg).
   */
  mask?: boolean | "glass";
  /** Host element/component. Defaults to a `div`. */
  as?: React.ElementType;
  /** Forwarded to the rendered element (mirrors Surface/Card/Row). */
  ref?: React.Ref<HTMLElement>;
}

/**
 * The sanctioned sticky-positioning primitive — pins a header/footer/sidebar to
 * a scroll edge with a z-layer-aware stacking level, the `sticky top-0 z-raised`
 * combination ~24 call sites wrote by hand.
 *
 * An opaque sticky header masks the content scrolling under it — use `mask` for
 * that (`bg-chrome-mask`, which follows the surface), NOT a hand-written
 * `bg-background` that assumes the surface is the page canvas. Borders and other
 * chrome stay in `className` (`border-*` / `backdrop-blur` are not banned).
 *
 * Caller `className` composes last; caller `style` overrides the edge offset.
 */
export function Sticky({
  active = true,
  edge = "top",
  offset = "none",
  layer = "raised",
  mask = false,
  as: As = "div",
  ref,
  className,
  style,
  children,
  ...rest
}: StickyProps) {
  const sticky = stickyClasses({ edge, offset, layer });
  return (
    <As
      ref={ref}
      className={cn(
        active && sticky.className,
        mask === true && "bg-chrome-mask",
        mask === "glass" &&
          "bg-chrome-mask/72 backdrop-blur-[14px] backdrop-saturate-[1.3]",
        className,
      )}
      style={{ ...(active ? sticky.style : null), ...style }}
      {...rest}
    >
      {children}
    </As>
  );
}
