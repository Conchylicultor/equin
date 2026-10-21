import {
  cn,
  SidewaysScrollProvider,
  SURFACE_LEVELS,
  type SurfaceLevel,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  selectScopeProps,
  scopeSelectAllKeyDown,
} from "@plugins/primitives/plugins/select-scope/web";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import type React from "react";

export interface SurfaceProps extends Passthrough {
  /**
   * Semantic elevation role — picks the frozen background (+ border / radius /
   * shadow) bundle from SURFACE_LEVELS. The whole point of the closed set: every
   * surface of a role looks identical and re-themes together on a preset swap.
   *   - `sunken`  — recessed well / band below the base plane (tone only)
   *   - `base`    — page / pane canvas, toolbar bands (tone only)
   *   - `raised`  — a card lifted above base (bg + border + radius + shadow)
   *   - `overlay` — floats above everything: popovers, menus, floating panels
   *   - `float`   — floating chrome over content (a toolbar card, a dock):
   *                 translucent glass, the material group's float tokens
   */
  level: SurfaceLevel;
  /**
   * Element to render. Default "div"; "section"/"button"/"a"/"li" as needed.
   * Purely a TAG choice — the surface is block-level regardless (see below), so
   * an inline-by-default tag like "a" still paints as a proper box.
   */
  as?: React.ElementType;
  /** Composed with the baked-in select-scope handler (consumer runs first). */
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
  /** Overrides the scope's default `-1` (e.g. `0` for keyboard-focusable surfaces). */
  tabIndex?: number;
  className?: string;
  children?: React.ReactNode;
}

/**
 * The box a surface is, per host tag — see the class comment in {@link Surface}
 * for why a `<button>` needs more than `block` to be a mere tag choice.
 */
const BOX_CLASS = {
  default: "block",
  button: "flex flex-col text-left",
} as const;

/**
 * The surface chrome primitive: one closed set of semantic elevation roles, each
 * a frozen bundle of background + border + radius + shadow drawn from the shared
 * SURFACE_LEVELS map (in ui-kit). Routing every panel / card / overlay through
 * `<Surface level>` is what makes a theme/preset swap move the whole app's depth
 * consistently instead of each call site freezing its own ad-hoc recipe.
 *
 * Like `<Card>` (which is now a thin `<Surface level="raised">` wrapper), the
 * Ctrl+A **select-scope** is baked into the ROOT element: the surface becomes the
 * scope, so a click into it + Ctrl+A selects only its subtree. The scope handler
 * is GUARANTEED to run even when the consumer passes its own `onKeyDown` — we
 * compose consumer-first, then the scope handler, and apply the merged handler
 * AFTER `{...rest}` so nothing can clobber it. (Consumer-first is safe: an
 * activation handler preventDefaults on Enter/Space, while the scope handler only
 * acts on Ctrl/Cmd+"a", so they never interfere.)
 */
export function Surface({
  level,
  as: Comp = "div",
  className,
  children,
  ref,
  onKeyDown,
  tabIndex,
  ...rest
}: SurfaceProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(e);
    scopeSelectAllKeyDown(e);
  };
  return (
    <Comp
      ref={ref}
      tabIndex={tabIndex ?? selectScopeProps.tabIndex}
      {...rest}
      onKeyDown={handleKeyDown}
      // The box class FIRST, so a consumer's own display class (`flex` / `grid`
      // / `hidden`) still wins through tailwind-merge. A surface is a CONTAINED
      // BOX, and `as` must not silently change what kind of box it is — two tags
      // carry layout of their own that would otherwise leak in:
      //   - `as="a"` is `display: inline` by default, and an inline box holding
      //     block-level children is split into fragments — the browser paints the
      //     bg/border/radius on the empty leading + trailing fragments, i.e. two
      //     stray slivers and no card chrome. `block` closes that.
      //   - `as="button"` centres its content, vertically AND horizontally, by
      //     UA rule (buttons are controls, and a control's label sits in its
      //     middle). A card that is a column of prose then sinks to the middle of
      //     whatever height its grid row stretched it to, and its lines centre —
      //     the two fork cards of the website shipped with their eyebrows on two
      //     different baselines for exactly this reason. A flex column with the
      //     default `flex-start` main-axis packing is the box a card actually is,
      //     and `text-left` returns the text to a paragraph's alignment.
      // Owning the display here is what makes `as` purely a choice of TAG
      // (semantics / interactivity), never of layout.
      className={cn(
        BOX_CLASS[Comp === "button" ? "button" : "default"],
        SURFACE_LEVELS[level],
        className,
      )}
    >
      {level === "base" ? (
        children
      ) : (
        // A drawn box (a card, a well, a floating card) ends the
        // sideways-scroll region: a wide table inside squeezes into it
        // rather than spilling past its edge. `base` is the canvas itself —
        // tone only, no edge to spill past.
        <SidewaysScrollProvider value={false}>
          {children}
        </SidewaysScrollProvider>
      )}
    </Comp>
  );
}
