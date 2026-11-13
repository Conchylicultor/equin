import {
  cn,
  ControlSizeProvider,
  type ControlSize,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import type { ElementType, HTMLAttributes } from "react";

export type BarTier = "chrome" | "pane" | "subpane";

export interface BarProps extends HTMLAttributes<HTMLElement> {
  /**
   * Which chrome tier this bar belongs to.
   * - `"chrome"` (default): the app/pane **toolbar** tier — a `<header>` at
   *   `h-chrome-bar`, `pl-chrome`, masked with `bg-chrome-mask` (the surface it
   *   sits on, page canvas by default). Reserves the floating-bar safe area by
   *   default (`endSafeArea`). Used by the app-shell toolbar and pane headers.
   * - `"pane"`: the **pane-header** tier — a `<div>` at the shorter `h-chrome-pane`
   *   inset by the pane edge on both sides (`px-chrome-pane`, density
   *   `documentPadX` — the edge every pane's header and body share; a
   *   `[data-pane-lead]` box hangs its glyph onto it) and `min-w-0`
   *   (truncation-safe). Used by PaneChrome.
   * - `"subpane"`: a pane's **secondary strip** under its header (the
   *   conversation toolbar) — a `<div>` as tall as its controls plus an `xs`
   *   block pad, inset by `px-subpane` (density `subpanePadX`, the `sm` step
   *   by default), `min-w-0`.
   */
  tier?: BarTier;
  /**
   * `"hidden"` (default) clips a too-wide single line. `"visible"` lets a
   * title-area child (e.g. CollapsibleWrap) spill expanded rows DOWN over the
   * content below instead of being clipped.
   */
  overflow?: "hidden" | "visible";
  /** Element override; defaults to the tier's semantic element (`header`/`div`). */
  as?: ElementType;
  /**
   * Reserve the floating-action-bar safe area on the right (`pr-floating-bar`).
   * Defaults on for `chrome` (unchanged behavior), off for `pane`. The pane
   * tier opts in when its header IS the surface's top chrome and sits at the
   * right edge, so the global floating bar doesn't occlude its actions. It
   * also names the bar the floating bar's anchor (`anchor-floating-bar-band`),
   * so the floating bar is centred on this bar's line.
   */
  endSafeArea?: boolean;
  /**
   * The control density declared for everything inside this bar; defaults to
   * `"sm"` (the chrome tier). Innermost provider wins, so a child region/slot
   * may override.
   */
  controlSize?: ControlSize;
}

/** Per-tier chrome: height token, horizontal inset, and (chrome only) the mask. */
const TIER_CLASS: Record<BarTier, string> = {
  chrome: "h-chrome-bar pl-chrome bg-chrome-mask",
  // The pane tier's rule width is a density token (`chromePaneRule`, default
  // the 1px `border-b`), so a theme can run a pane header into its pane.
  // Its glyphs take the `toolbarForeground` colour (default `currentColor`,
  // the colour they always inherited).
  pane: "h-chrome-pane px-chrome-pane min-w-0 border-b-chrome-pane text-toolbar-foreground",
  subpane: "py-xs px-subpane min-w-0",
};

/** The end inset that reserves the floating bar's safe area, per tier: the
 *  safe area when one is published, the tier's own end inset otherwise. */
const SAFE_AREA_CLASS: Record<BarTier, string> = {
  chrome: "pr-floating-bar",
  pane: "pr-floating-bar-pane",
  subpane: "pr-floating-bar",
};

const TIER_ELEMENT: Record<BarTier, ElementType> = {
  chrome: "header",
  pane: "div",
  subpane: "div",
};

/**
 * The single-line chrome-strip primitive — the horizontal toolbar/header band
 * shared by the app-shell toolbar and pane headers.
 *
 * Bar owns ONLY the strip chrome (the flex row, the single-line invariant via
 * `region-line`, the bottom border, the tier height + inset, and clipping). It
 * has no slots and hosts no content of its own: each consumer composes `<Bar>`
 * and supplies what it hosts (sidebar trigger, reorderable start/end zones,
 * title + promote + close, …). This is the factor-not-collapse boundary — a
 * bar, a row, and a chip stay distinct primitives; only the single-line region
 * invariant (`region-line`) is shared between them.
 *
 * Hand-rolling this strip is banned by `bar/no-adhoc-bar`.
 */
export function Bar({
  tier = "chrome",
  overflow = "hidden",
  as,
  endSafeArea,
  controlSize = "sm",
  className,
  children,
  ...rest
}: BarProps) {
  const As = as ?? TIER_ELEMENT[tier];
  const safe = endSafeArea ?? tier === "chrome";
  return (
    // The single-line contract (region-line + SingleLineProvider) comes from
    // <Line>; Bar layers its strip chrome (border, tier height/inset, clip) on top.
    <Line
      as={As}
      // eslint-disable-next-line layout/no-adhoc-layout, rail/no-adhoc-band -- Bar is the sanctioned single-line chrome-strip primitive (enforced by bar/no-adhoc-bar); it owns its own raw min-w-0 + clip mechanics, the same way the css/* layout primitives own theirs; and it IS the pane/app chrome strip, whose inset is its tier's chrome pad (the floor bands and followers land on)
      className={cn(
        "gap-sm border-b",
        TIER_CLASS[tier],
        // The bar reserving the floating bar's room is also the row it sits
        // in: naming it the band's anchor centres the bar on this line.
        safe && [SAFE_AREA_CLASS[tier], "anchor-floating-bar-band"],
        overflow === "visible" ? "overflow-visible" : "overflow-hidden",
        className,
      )}
      {...rest}
    >
      <ControlSizeProvider size={controlSize}>{children}</ControlSizeProvider>
    </Line>
  );
}
