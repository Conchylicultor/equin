import { useCallback } from "react";
import type * as React from "react";

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils";
import { SURFACE_LEVELS } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/surface";
import {
  POPOVER_WIDTH,
  POPOVER_PADDING,
  POPOVER_MAX_HEIGHT,
  type PopoverWidth,
  type PopoverPadding,
  type PopoverMaxHeight,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/popover-width";
import { SingleLineProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/single-line";
import { SidewaysScrollProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/sideways-scroll";
import { scopeSelectAllKeyDown } from "@plugins/primitives/plugins/select-scope/web";
import { useRailGuard } from "@plugins/primitives/plugins/css/plugins/rail/web";
import { OverlayBoundary } from "@plugins/primitives/plugins/overlay/plugins/overlay-boundary/web";
import { useScrollFade } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/use-scroll-fade";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import { IconScopeProvider } from "@plugins/ui/plugins/icons/web";
import { usePortalThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/portal-theme-scope";

/**
 * The floating panel an element sits in, or null when it is in none — for
 * something hung off a row INSIDE a panel that places itself against the
 * panel's edge rather than the row's (a hover card beside its menu).
 */
export function closestOverlayPanel(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>("[data-overlay-panel]");
}

/** Pins the sticky header at the panel's true top edge, through its block
 *  padding (see the header below). */
const HEADER_PIN_STYLE = { top: "calc(-1 * var(--rail-block-start, 0px))" };

/**
 * THE floating panel — the one definition of the box every overlay surface
 * contains.
 *
 * A popover, a menu, a listbox, a caret surface and a dialog are five different
 * *state machines* (base-ui's listbox / menu / dialog, plus one deliberately
 * focus-less Floating-UI surface). They are ONE panel: the same overlay paint,
 * the same open/close animation, the same width / padding / max-height ramp, the
 * same viewport fit, the same content-context resets. Re-deriving that panel per
 * component is what let `PopoverContent` ship with no height clamp at all while
 * its four siblings each had a different one.
 *
 * Composed into a state machine through base-ui's `render` prop, which
 * `cloneElement`s this element with the popup's merged props — so the ROOT here
 * must be a real host element that spreads `{...rest}`; a root that emits no DOM
 * node would silently swallow the popup's `ref`, handlers and aria wiring. Those
 * merged props ARE this panel's passthrough ({@link Passthrough}), `ref`
 * included: the panel composes the popup's ref with its own measurement and rail
 * refs onto the one root, rather than picking one of them.
 *
 * Two things are INVARIANTS, not props — a call site cannot forget them:
 *
 *  - **Fit the viewport, and scroll** — unless the caller declares the panel
 *    is no scroller (`scroll={false}`, below). `maxHeight` is only a comfort cap layered
 *    on top (see `POPOVER_MAX_HEIGHT`); the clamp-to-`--available-height` and the
 *    scroller are unconditional. X is hidden rather than scrolled because CSS
 *    cannot pair `overflow-y: auto` with `overflow-x: visible` — asking for one
 *    axis forces a value on both. A panel holding content of unbounded natural
 *    width wants `width="fit"`, not a fixed width it would clip.
 *  - **The clamp announces itself.** A panel clamped to the viewport is only
 *    honest if the user can tell there is more below: with macOS overlay
 *    scrollbars invisible at rest, eight items ending in clean padding read as a
 *    complete list of eight. The `scroll-fade` utility paints a sticky gradient at
 *    an edge that has content beyond it — bottom until the end is reached, top
 *    once scrolled — measured by {@link useScrollFade} and never merely assumed.
 *    Additive only: no scrollbar chrome is touched, so the native transient
 *    scrollbar still appears during a gesture.
 *  - **Ctrl+A scopes to the panel.** Bound on the root rather than through a
 *    `<ContentScope>` wrapper: an intervening auto-height div would break the
 *    `height: 100%` / `max-height: 100%` percentage chain base-ui's `SelectPopup`
 *    installs for `alignItemWithTrigger`. No `tabIndex` either — base-ui already
 *    stamps one on every popup, and focus is inside the panel already, so the
 *    keydown reaches the root by bubbling.
 */
export interface OverlayPanelProps extends Passthrough<HTMLDivElement> {
  /** Closed width role; default size-to-content. */
  width?: PopoverWidth;
  /** Padding role; default `md`. */
  padding?: PopoverPadding;
  /** Comfort cap on top of the unconditional viewport fit; default `viewport`. */
  maxHeight?: PopoverMaxHeight;
  /**
   * `true` (default): the panel fits the viewport and scrolls, with edge fades.
   * `false`: the panel is not a scroller and owns its overflow — for a small
   * panel whose natural size always fits (a toolbar, a disclosure morphing open
   * out of its trigger), holding content that may legitimately draw past its
   * box. It gives up the viewport clamp, the scroller and the fades;
   * `maxHeight` does not apply.
   */
  scroll?: boolean;
  /** Optional sticky header rendered above the content, full-bleed through the padding. */
  header?: React.ReactNode;
  /** Landing spot for a consumer override — always the LAST `cn()` argument. */
  className?: string;
  children?: React.ReactNode;
  /** Composed with the baked-in select-scope handler (consumer runs first). */
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  /** Composed with the baked-in scroll-fade measurement (consumer runs first). */
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}

export function OverlayPanel({
  width = "content",
  padding = "md",
  maxHeight = "viewport",
  scroll = true,
  header,
  className,
  children,
  ref,
  onKeyDown,
  onScroll,
  ...rest
}: OverlayPanelProps) {
  // The panel IS the scroller, so it is also what the edge fades measure. The
  // node takes one `ref`, so the fade's measurement ref and the caller's compose
  // here (base-ui merges the popup's own ref into `ref`, so dropping it would
  // silently break every floating surface).
  const {
    measureRef,
    onScroll: measureScroll,
    top,
    bottom,
  } = useScrollFade<HTMLDivElement>();
  // The `padding` role IS this panel's rail region (`POPOVER_PADDING` maps each
  // role to one `rail-<step>`), so the panel is the publisher and the guard
  // belongs on its own box — the rail is measured from the publisher's PADDING
  // box, which for this bordered surface is one pixel inside its border box.
  const railRef = useRailGuard<HTMLDivElement>("OverlayPanel");
  const panelRef = useCallback(
    (el: HTMLDivElement | null) => {
      measureRef(el);
      railRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [measureRef, railRef, ref],
  );
  // Consumer first, then the scope — and the merged handler applied AFTER
  // `{...rest}` so nothing in the popup's merged props can clobber it. Safe in
  // either order: the scope handler only acts on Ctrl/Cmd+"a", which nothing in
  // the base-ui stack reads (typeahead bails on modifiers, dismiss reads Escape).
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    scopeSelectAllKeyDown(e);
  };
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    onScroll?.(e);
    measureScroll();
  };
  // The theme scope this panel's portal re-stamps (the popup bag): the icons
  // inside draw in THAT scope's style, so a popup that wears a different theme
  // from its trigger (a `PopupTheme`, e.g. the app launcher's chrome grid)
  // draws its icons in that theme's family too.
  const popupScope = usePortalThemeScope();
  return (
    <div
      ref={panelRef}
      {...rest}
      onKeyDown={handleKeyDown}
      onScroll={handleScroll}
      // Presence-only: the CSS gates each gradient on its attribute existing, so
      // an absent attribute is "no content that way", never "unknown".
      // Names the box as a floating panel, so something hung off a row INSIDE
      // it can find the panel's edge (a hover card placed beside its menu).
      data-overlay-panel=""
      data-fade-top={top ? "" : undefined}
      data-fade-bottom={bottom ? "" : undefined}
      className={cn(
        SURFACE_LEVELS.overlay,
        // The union of what the five surfaces each animated with. `inline-start`
        // / `inline-end` are the logical sides base-ui's Menu resolves a submenu
        // to, and `data-closed:overflow-hidden` suppresses the scrollbar flash
        // while a panel zooms out. Both are inert `data-*` selectors on a surface
        // that never sets those attributes, so the superset costs nothing and
        // keeps the blob a single shared definition rather than a per-surface one.
        "z-popover origin-(--transform-origin) duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95",
        POPOVER_WIDTH[width],
        POPOVER_PADDING[padding],
        scroll && [
          POPOVER_MAX_HEIGHT[maxHeight],
          "scroll-fade overflow-x-hidden overflow-y-auto",
        ],
        className,
      )}
    >
      {/* A floating panel is a fresh flow root: reset the ambient single-line
          contract so content opened from a line container (Bar/Row) wraps /
          pretty-prints instead of collapsing onto one line. Line containers
          inside re-assert `true` locally. Outside the boundary so the crash
          fallback gets the reset too. */}
      <SingleLineProvider value={false}>
        {/* A drawn box: a table inside squeezes rather than spilling past the
            panel's edge (see `sideways-scroll.tsx`). */}
        <SidewaysScrollProvider value={false}>
          <OverlayBoundary>
            {header != null && (
              // `rail-bleed` for the inline half: it cancels and re-applies
              // whatever rail the panel is ACTUALLY on, which the `-mx-1` here
              // before it did not — the default role is `md` (0.75rem), so a
              // hardcoded 4px left every popover header visibly inset, and each of
              // the six roles wanted a different number.
              // `-mt-1` stays hardcoded because there is no block bleed in the
              // contract: `--rail-block-*` is published for `scroll-fade` to read,
              // and the escape is inline-only by design.
              // The pin offset is that published block rail, negated: a sticky
              // box pins at its scroller's PADDING edge, so `top: 0` here left a
              // strip of the panel's block padding above the pinned header where
              // the scrolled items showed through.
              <div
                // eslint-disable-next-line spacing/no-adhoc-spacing -- -mt-1 bleeds the header through the panel's block padding (the contract has no block escape and no named negative-margin utility); mb-1 spaces the first item off the header's border, and the ramp has no margin classes — the children are the caller's, so there is no parent gap to own it
                className="sticky z-raised rail-bleed -mt-1 mb-1 border-b bg-popover py-xs"
                style={HEADER_PIN_STYLE}
              >
                {header}
              </div>
            )}
            <IconScopeProvider scope={popupScope}>{children}</IconScopeProvider>
          </OverlayBoundary>
        </SidewaysScrollProvider>
      </SingleLineProvider>
    </div>
  );
}
