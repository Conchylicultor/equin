import { useEffect, useState, type ReactElement } from "react";
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react-dom";
import { OverlayPanel } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import type { PortalForwardedAttrs } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

export interface OverflowPanelProps {
  open: boolean;
  /** The `⋯` trigger the panel positions against. */
  anchor: HTMLElement | null;
  /** Accessible name for the panel — the bar's own label. */
  label: string;
  /** Receives the dock: the one element relocated containers are moved into. */
  dockRef: (el: HTMLElement | null) => void;
  /**
   * The bar's REGION attributes (theme scope, sub-theme included), stamped on
   * the dock. The panel is body-portaled and its overlay carries only the popup
   * bag, but a parked occupant is still part of the bar's region — and it
   * stamps only what differs from these, so the dock must carry the rest.
   */
  dockAttrs: PortalForwardedAttrs;
  onDismiss: () => void;
}

/**
 * The overflow panel — **always mounted, never unmounted, closed only in CSS**.
 *
 * This is the constraint everything else in the file bends to. The panel holds
 * the LIVE DOM of relocated widgets: a Web Audio volume control, a jog wheel
 * mid-fling, a slider whose `aria-valuenow` is the user's actual setting.
 * `Popover` and `DropdownMenu` both unmount their content on close, which would
 * destroy the dock and orphan every container hanging off it — the single
 * instance this primitive exists to preserve would die every time the panel
 * closed. So "closed" is `display: none` + `inert` + `aria-hidden`, and the
 * dock's identity outlives every open/close cycle.
 *
 * `inert` is not decoration either: without it a parked `role="slider"` stays
 * focusable and Tab drops the user into an invisible control.
 *
 * The surface is a plain **dialog** and nothing about it is derived from its
 * occupants. A `role="menu"` was the obvious-looking alternative and is wrong
 * twice over: menu content unmounts on close (above), and inside a menu the
 * roving tabindex and typeahead own the arrow keys a relocated slider needs.
 * Here Tab reaches the widget, arrows reach the slider, Esc closes — and
 * because it is the same instance, the drag physics come along untouched. The
 * honest cost is that the panel has no typeahead and no arrow-key roving.
 *
 * It composes the same three pieces `floating-surface` does — `ViewportOverlay`
 * + `OverlayPanel` + Floating UI — rather than reusing `FloatingSurface`
 * itself, which returns `null` when closed and would therefore reintroduce
 * exactly the unmount this design cannot have.
 */
export function OverflowPanel({
  open,
  anchor,
  label,
  dockRef,
  dockAttrs,
  onDismiss,
}: OverflowPanelProps): ReactElement {
  const [floatingEl, setFloatingEl] = useState<HTMLElement | null>(null);

  const { floatingStyles, isPositioned } = useFloating({
    open,
    strategy: "fixed",
    placement: "bottom-end",
    // `autoUpdate` keeps the panel on its trigger through scroll and resize.
    // A resize NEVER closes the panel — the user opened it, and the bar
    // re-fitting underneath is not a reason to take it away.
    //
    // Only while OPEN: the panel is always mounted (above), so an unconditional
    // `autoUpdate` would watch the anchor and reposition a `display: none`
    // panel on every layout shift of the page for as long as the bar lives.
    // Opening flips this on, which re-runs Floating UI's mount effect and
    // `autoUpdate` positions the panel at once.
    whileElementsMounted: open ? autoUpdate : undefined,
    // The anchor is handed over only while open, for the same reason: with
    // both elements set and no `whileElementsMounted`, Floating UI still
    // positions once on mount — one async state update, so one commit, per
    // closed panel. A sidebar of collapsed rows is one panel per row.
    elements: { reference: open ? anchor : null, floating: floatingEl },
    middleware: [offset(4), flip({ padding: 9 }), shift({ padding: 8 })],
  });

  // Esc and outside-press close. Both are document-level and capture-phase so
  // they still fire for a press that lands inside a relocated widget's own
  // popover, which lives in the top layer above everything.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onDismiss();
    }
    function onPointerDown(e: PointerEvent): void {
      const target = e.target as Node | null;
      if (target === null) return;
      if (floatingEl?.contains(target) === true) return;
      if (anchor?.contains(target) === true) return;
      onDismiss();
    }
    // eslint-disable-next-line shortcuts/no-window-key-listener -- listens only while this panel is open; capture-phase on the document so Escape still reaches it from a relocated widget's own top-layer popover, and any outside press closes it.
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onDismiss, floatingEl, anchor]);

  return (
    <ViewportOverlay
      layer="popover"
      // The overlay itself is always painted and always click-through; only the
      // panel inside it takes pointers, and only while open.
      className="pointer-events-none"
      aria-hidden={!open}
    >
      <OverlayPanel
        ref={setFloatingEl}
        role="dialog"
        aria-label={label}
        // Positioning is an inline style, so it is the only `fixed` in the tree
        // and invisible to `layout/no-adhoc-layout` (which scans classNames).
        // `display: none` rides along for the same reason — and because a
        // className toggle would be a second thing that could disagree with
        // `inert`.
        style={{ ...floatingStyles, display: open ? undefined : "none" }}
        inert={!open}
        aria-hidden={!open}
        padding="xs"
        // Invisible until placed. Closed, the panel has no reference, so its
        // styles sit at the viewport origin; opening shows it in that same
        // commit, and Floating UI's first measurement lands a commit later —
        // the panel would flash top-left for a frame. Same guard as
        // `floating-surface`: hidden until positioned, and it fades in.
        data-positioned={isPositioned ? "" : undefined}
        className="pointer-events-auto transition-opacity not-data-[positioned]:opacity-0"
      >
        <Stack ref={dockRef} gap="2xs" align="stretch" {...dockAttrs} />
      </OverlayPanel>
    </ViewportOverlay>
  );
}
