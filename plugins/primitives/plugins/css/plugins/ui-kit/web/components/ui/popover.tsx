import * as React from "react";
import { MenuSurfaceProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/menu-surface";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { usePortalForwardedAttrs } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/portal-forward";
import { usePopupOpenMirror } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/popup-open-mirror";
import { useFrameFocusDismiss } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/frame-focus-dismiss";
import { OverlayPanel } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/overlay-panel";
import type {
  PopoverWidth,
  PopoverPadding,
  PopoverMaxHeight,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/popover-width";
import { usePortalContainer } from "@plugins/primitives/plugins/overlay/plugins/portal-host/web";

/**
 * Whether this popover has ever been open. Once it has, its content stays
 * mounted (hidden) across closes — see `PopoverContent`'s `resetOnClose`.
 */
const PopoverEverOpenedContext = React.createContext(false);

/**
 * Registers a hold on the enclosing popover, returning its release: while any
 * hold is registered, a request to close (an outside press, a focus moving out)
 * is refused. `null` outside a popover.
 */
const PopoverHoldContext = React.createContext<(() => () => void) | null>(null);

/**
 * Keep the enclosing popover open while `active` — for content that hands the
 * pointer to the rest of the page for a while (an element picker inside the
 * popover, whose pass-through clicks land outside it) and must still be there
 * afterwards. A no-op outside a popover. The popover still closes when its
 * owner closes it (a controlled `open` set to false).
 */
function useHoldPopoverOpen(active: boolean): void {
  const hold = React.useContext(PopoverHoldContext);
  React.useEffect(() => {
    if (!active || !hold) return;
    return hold();
  }, [active, hold]);
}

function Popover({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: Omit<PopoverPrimitive.Root.Props, "actionsRef">) {
  // See `usePopupOpenMirror`: the enclosing PopupOpenScope reads this instead of
  // a CSS selector over base-ui's own open-state attribute.
  const { onOpenChange: handleOpenChange, isOpen } = usePopupOpenMirror({
    open,
    defaultOpen,
    onOpenChange,
  });
  // A click inside an iframe never reaches base-ui's outside-press listener.
  const actionsRef =
    useFrameFocusDismiss<PopoverPrimitive.Root.Actions>(isOpen);
  // Latched on first open (the render-phase "adjust state on prop change"
  // pattern): a popover never opened mounts nothing, one opened once keeps its
  // content — so whatever the user typed in it survives closing it.
  const [everOpened, setEverOpened] = React.useState(isOpen);
  if (isOpen && !everOpened) setEverOpened(true);
  // See `useHoldPopoverOpen`: a refused close is cancelled before the mirror or
  // the caller hears of it, so neither ever sees the popover as closed.
  const holds = React.useRef(0);
  const hold = React.useCallback(() => {
    holds.current += 1;
    return () => {
      holds.current -= 1;
    };
  }, []);
  const guardedOpenChange: NonNullable<
    PopoverPrimitive.Root.Props["onOpenChange"]
  > = (next, details) => {
    if (!next && holds.current > 0) {
      details.cancel();
      return;
    }
    handleOpenChange(next, details);
  };
  // Outside the Root: its children may be a payload render function.
  return (
    <PopoverEverOpenedContext.Provider value={everOpened}>
      <PopoverHoldContext.Provider value={hold}>
        <PopoverPrimitive.Root
          open={open}
          defaultOpen={defaultOpen}
          onOpenChange={guardedOpenChange}
          actionsRef={actionsRef}
          {...props}
        />
      </PopoverHoldContext.Provider>
    </PopoverEverOpenedContext.Provider>
  );
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  anchor,
  collisionAvoidance,
  width = "content",
  padding = "panel",
  maxHeight = "viewport",
  header,
  resetOnClose = false,
  className,
  children,
  ...props
}: Omit<PopoverPrimitive.Popup.Props, "render" | "className"> &
  Pick<
    PopoverPrimitive.Positioner.Props,
    | "align"
    | "alignOffset"
    | "side"
    | "sideOffset"
    | "anchor"
    | "collisionAvoidance"
  > & {
    /**
     * Plain override class landing LAST on the panel. Narrower than base-ui's
     * `className`, which also accepts a `(state) => string` form: the panel is
     * composed by `OverlayPanel`, which has no access to the popup's state, and
     * the state-driven variants are already expressed as `data-*` selectors in
     * the panel's own class bundle.
     */
    className?: string;
    /** Closed width role; default size-to-content. */
    width?: PopoverWidth;
    /** Padding role; default `panel` — the theme's popover inset (`md` unless a theme sets `popoverPad`). */
    padding?: PopoverPadding;
    /**
     * Max-height COMFORT CAP on top of the unconditional viewport fit; default
     * `viewport` (fit the space Floating UI measured, and nothing tighter).
     */
    maxHeight?: PopoverMaxHeight;
    /** Optional sticky header rendered above the content, full-bleed through the padding. */
    header?: React.ReactNode;
    /**
     * Unmount the content on close, so every open starts from fresh state.
     *
     * Default `false`: once opened, the content stays mounted (hidden) while
     * closed, so a draft typed into it — a launch prompt, a filter value, a
     * half-written link — is never lost to dismissing the popover. Opt in only
     * where fresh state is the point: content that seeds its state once from a
     * value that may change while closed, or that runs live work (streams,
     * subscriptions) that must stop while hidden. A draft that must also
     * survive the HOST unmounting (reload, navigation) belongs in
     * `persistent-draft`, not here.
     */
    resetOnClose?: boolean;
  }) {
  // Portaled content escapes the originating window's DOM subtree to
  // document.body, so it no longer matches that window's [data-theme-scope]
  // block. Re-stamp the scope here (flowing through React context, which
  // crosses portals) so the popup adopts the launching window's scoped theme
  // instead of the global :root chrome theme. Undefined → no attribute → default.
  const forwarded = usePortalForwardedAttrs();
  // Inside a PortalHost (a fullscreen region), draw there: under `body` the
  // popup would be invisible.
  const container = usePortalContainer();
  const everOpened = React.useContext(PopoverEverOpenedContext);
  return (
    <MenuSurfaceProvider value={true}>
      <PopoverPrimitive.Portal
        container={container}
        keepMounted={everOpened && !resetOnClose}
      >
        <PopoverPrimitive.Positioner
          {...forwarded}
          className="isolate z-popover outline-none"
          align={align}
          alignOffset={alignOffset}
          side={side}
          sideOffset={sideOffset}
          anchor={anchor}
          // Never fall back to the perpendicular axis. base-ui's default
          // (`fallbackAxisSide: "end"`) re-flips a panel clamped to its
          // `--available-height` whenever its content grows (a row expanding),
          // and a bottom popover under a top-bar trigger then jumps beside the
          // trigger at full viewport height. The panel always fits and scrolls
          // (`OverlayPanel`), so it keeps its side and scrolls instead.
          collisionAvoidance={{
            fallbackAxisSide: "none",
            ...collisionAvoidance,
          }}
        >
          {/* The popup IS the shared panel: base-ui owns the state machine, and
            `render` hands it `OverlayPanel` as the element to clone its merged
            props onto (`{...props}` stays BEFORE `render`, and `render` is
            `Omit`ed from the public prop type, so a caller can never replace the
            panel). Chrome, geometry, viewport fit and the content-context resets
            all live in one place — see `overlay-panel.tsx`. */}
          <PopoverPrimitive.Popup
            data-slot="popover-content"
            {...props}
            render={
              <OverlayPanel
                width={width}
                padding={padding}
                maxHeight={maxHeight}
                header={header}
                className={className}
              >
                {children}
              </OverlayPanel>
            }
          />
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </MenuSurfaceProvider>
  );
}

export { Popover, PopoverTrigger, PopoverContent, useHoldPopoverOpen };
