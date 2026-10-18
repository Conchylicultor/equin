import { useEffect, useMemo, useState, type PointerEventHandler } from "react";
import {
  useFloating,
  offset,
  flip,
  shift,
  size,
  autoUpdate,
  type Placement,
} from "@floating-ui/react-dom";
import {
  cn,
  OverlayPanel,
  type PopoverWidth,
  type PopoverPadding,
  type PopoverMaxHeight,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";

/**
 * A FOCUS-LESS, caret-anchored floating surface.
 *
 * It positions a panel against a transient **virtual anchor** (a caret/selection
 * rect, or any `{ getBoundingClientRect }` virtual element) via Floating UI — and
 * **never touches focus**. This is what sets it apart from base-ui's `Popover`:
 * a trigger popover *should* move focus into its panel, but a caret menu must keep
 * the caret live in the host contenteditable (Lexical drives navigation; rows
 * `preventDefault` on mousedown to keep focus). Bending `Popover.Root`'s focus
 * management off would fight its abstraction, so this is a **sibling** primitive,
 * not an extension of it — exactly the stance `format-toolbar-plugin` already takes.
 *
 * It composes the same VISUAL primitives that sit one layer below base-ui's
 * Popover — `ViewportOverlay` (portal to document.body + z-layer + theme-scope,
 * click-through) wrapping THE shared `<OverlayPanel>`, the one definition of the
 * floating panel that `PopoverContent` / `DropdownMenuContent` / `SelectContent` /
 * `DialogContent` also render — so the chrome, the width/padding/max-height roles,
 * the unconditional viewport fit and the content-context resets are byte-identical
 * to a real popover's. This is the panel's STANDALONE use: the other four hand it
 * to base-ui through a `render` prop, here it is simply the rendered element.
 * Floating UI is the same engine base-ui's Positioner uses internally; here we use
 * it directly, minus the focus/dismiss wrapper, and gain flip + scroll-follow for
 * free.
 *
 * Positioning is returned as an inline `style` object (`floatingStyles`), so it is
 * the only `fixed` in the tree and is invisible to `layout/no-adhoc-layout` (which
 * only scans `className` strings) — no eslint-disable anywhere.
 */

/**
 * Caret/selection rect, or any object exposing one (a Floating UI virtual element).
 * A virtual element names the DOM node it lives in as `contextElement`, so
 * `autoUpdate` follows the scroll of that node's scroll containers — without it,
 * only the window's scroll is followed, and an anchor inside a scrolling pane
 * leaves the surface behind.
 */
export type FloatingAnchor = DOMRect | VirtualAnchor;

interface VirtualAnchor {
  getBoundingClientRect: () => DOMRect;
  contextElement?: Element;
}

export interface FloatingSurfaceProps {
  /** Whether the surface is shown. Returns `null` when false (or `anchor` is null). */
  open: boolean;
  /** The caret/selection rect or virtual element the surface anchors to. */
  anchor: FloatingAnchor | null;
  children: React.ReactNode;
  /** Width role (default `"content"` — size to content). */
  width?: PopoverWidth;
  /** Padding role (default `"xs"`). */
  padding?: PopoverPadding;
  /**
   * Max-height COMFORT CAP on top of the unconditional viewport fit (default
   * `"viewport"` — fit the space Floating UI measured, and nothing tighter).
   * Scrolling is not part of the role: the surface always scrolls internally.
   */
  maxHeight?: PopoverMaxHeight;
  /**
   * Whether the panel scrolls (default) — see `OverlayPanel`'s `scroll`: a
   * small toolbar holding a control that draws past its box passes `false`.
   */
  scroll?: boolean;
  /** Preferred side of the anchor (default `"bottom"`). Flips on collision. */
  side?: "top" | "right" | "bottom" | "left";
  /** Alignment along the chosen side (default `"start"`). */
  align?: "start" | "center" | "end";
  /** Gap between the anchor and the surface, in px (default `4`). */
  sideOffset?: number;
  /** Opt-in focus-safe outside-press close (never preventDefaults or focuses). */
  onDismiss?: () => void;
  /**
   * Identity change re-runs Floating UI `update()` — pass the host's live query
   * string when keystroke caret-follow needs to be tighter than `autoUpdate`'s
   * scroll/resize cadence.
   */
  reposition?: unknown;
  /**
   * The panel's own look, merged LAST over `OverlayPanel`'s chrome — for a
   * surface whose design is not the menu panel's (the desktop shelf's frosted
   * peek). An entry keyframe (`animate-in …`) is safe here: the panel is placed
   * by `left`/`top`, never `transform`, so the keyframe cannot displace it.
   */
  className?: string;
  /** Hover intent owned by the host (a grace-delayed hide that the panel cancels). */
  onPointerEnter?: PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: PointerEventHandler<HTMLDivElement>;
}

/** A DOMRect anchor is wrapped into a virtual element; a virtual element passes through. */
function toVirtualElement(anchor: FloatingAnchor): VirtualAnchor {
  if (anchor instanceof DOMRect) {
    return { getBoundingClientRect: () => anchor };
  }
  return anchor;
}

/** Maps the side+align prop pair to a Floating UI placement string. */
function toPlacement(
  side: NonNullable<FloatingSurfaceProps["side"]>,
  align: NonNullable<FloatingSurfaceProps["align"]>,
): Placement {
  return align === "center" ? side : (`${side}-${align}` as Placement);
}

export function FloatingSurface({
  open,
  anchor,
  children,
  width = "content",
  padding = "xs",
  maxHeight = "viewport",
  scroll = true,
  side = "bottom",
  align = "start",
  sideOffset = 4,
  onDismiss,
  reposition,
  className,
  onPointerEnter,
  onPointerLeave,
}: FloatingSurfaceProps) {
  // The floating node is tracked as STATE via a callback ref (a `useState`
  // setter), not a React ref — so nothing reads a ref during render (the strict
  // `react-hooks/refs` rule). The reference is a CONTROLLED virtual element:
  // callers pass a fresh `caretAnchor()` each render, so `anchor` identity changes
  // as the caret moves and Floating UI re-positions; `autoUpdate` covers scroll/resize.
  const [floatingEl, setFloatingEl] = useState<HTMLElement | null>(null);
  const reference = useMemo(
    () => (anchor ? toVirtualElement(anchor) : null),
    [anchor],
  );

  const { floatingStyles, update, isPositioned } = useFloating({
    open,
    strategy: "fixed",
    // Placed by `left`/`top`, not a `transform`: an entry keyframe on the panel
    // animates `transform`, and while it runs it would override a positioning
    // transform — the panel would play its entry at the viewport origin.
    transform: false,
    placement: toPlacement(side, align),
    whileElementsMounted: autoUpdate,
    elements: { reference, floating: floatingEl },
    middleware: [
      offset(sideOffset),
      // FLIP'S PADDING MUST EXCEED SIZE'S — this 1px gap is a deliberate
      // hysteresis, not a rounding allowance.
      //
      // Once `max-h` is derived from `--available-height`, the panel's height
      // depends on the placement that `flip` decides FROM that height, and
      // floating-ui re-runs the whole middleware chain whenever `size.apply`
      // changes the element's dimensions. On the re-run, `flip` would measure a
      // panel just clamped to exactly the available space, see zero overflow, and
      // conclude the cramped side is fine — so a menu near the bottom edge stays
      // pinned there, squeezed, instead of flipping up. Giving `flip` one extra
      // pixel of collision padding means the size-clamped panel still overflows
      // *flip's* boundary by 1px, so the flip decision survives its own effect.
      // Base-ui does exactly this (`useAnchorPositioning.js`: flip padding =
      // collision padding + a `bias` of 1, with the same comment).
      flip({ padding: 9 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableWidth, availableHeight, rects, elements }) {
          // Reproduce the CSS vars base-ui's Positioner exposes, so the
          // `max-w-(--available-width)` width roles and the `--available-height`
          // max-height clamp keep working unchanged.
          const style = elements.floating.style;
          style.setProperty("--available-width", `${availableWidth}px`);
          style.setProperty("--available-height", `${availableHeight}px`);
          // `--anchor-*` is the other half of what base-ui publishes: the width
          // roles that size to the trigger read it. Snapped to device pixels the
          // same way base-ui does, so a panel matched to its anchor lands on the
          // same physical edge instead of a half-pixel off.
          const dpr = window.devicePixelRatio || 1;
          const { x, y, width: aw, height: ah } = rects.reference;
          const anchorWidth =
            (Math.round((x + aw) * dpr) - Math.round(x * dpr)) / dpr;
          const anchorHeight =
            (Math.round((y + ah) * dpr) - Math.round(y * dpr)) / dpr;
          style.setProperty("--anchor-width", `${anchorWidth}px`);
          style.setProperty("--anchor-height", `${anchorHeight}px`);
        },
      }),
    ],
  });

  // Explicit reposition nudge for hosts that memoize their anchor (an inline
  // `caretAnchor()` already re-positions via the controlled `reference` above).
  useEffect(() => {
    if (open) update();
  }, [open, reposition, update]);

  // Focus-safe outside-press close: a capture-phase document listener that closes
  // on a press outside the surface. It never preventDefaults and never focuses
  // anything, so the caret stays live in the host.
  useEffect(() => {
    if (!open || !onDismiss) return;
    const dismiss = onDismiss;
    function onPointerDown(e: PointerEvent) {
      if (floatingEl && floatingEl.contains(e.target as Node)) return;
      dismiss();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, onDismiss, floatingEl]);

  if (!open || !anchor) return null;

  // `OverlayPanel` forwards both `ref` (an explicit `React.Ref<HTMLDivElement>`
  // prop) and `style` (via its `{...rest}` passthrough) to its root div, so the
  // `setFloatingEl` callback ref and Floating UI's positioning go straight to the
  // panel — no wrapper div. The host never needs the surface node: outside-press
  // containment is owned here.
  //
  // The panel's own Ctrl+A scope handler comes along for the ride and is inert
  // here BY DESIGN: this surface never takes focus (the caret stays live in the
  // host editor), so a Ctrl+A never originates inside the panel to bubble to it.
  return (
    <ViewportOverlay layer="popover" className="pointer-events-none">
      <OverlayPanel
        ref={setFloatingEl}
        style={floatingStyles}
        width={width}
        padding={padding}
        maxHeight={maxHeight}
        scroll={scroll}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        // Hidden until placed. Floating UI's first position lands a commit
        // after the mount, so for one frame the panel sits at the viewport
        // origin; it fades in where it belongs instead of painting there.
        // (It cannot SLIDE from the origin: `app.css` gives every element
        // `transition-property: none`, and only opacity is named here.)
        data-positioned={isPositioned ? "" : undefined}
        className={cn(
          "pointer-events-auto transition-opacity not-data-[positioned]:opacity-0",
          className,
        )}
      >
        {children}
      </OverlayPanel>
    </ViewportOverlay>
  );
}
