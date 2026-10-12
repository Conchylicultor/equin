import type * as React from "react";
import { MenuSurfaceProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/menu-surface";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/button";
import { usePortalForwardedAttrs } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/portal-forward";
import { OverlayPanel } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/overlay-panel";
import { usePortalContainer } from "@plugins/primitives/plugins/overlay/plugins/portal-host/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const closeIcon = symbol("close");

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  const container = usePortalContainer();
  return (
    <DialogPrimitive.Portal
      data-slot="dialog-portal"
      container={container}
      {...props}
    />
  );
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-popover bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Width tiers, applied to the POPUP — not to the panel inside it. The popup's
 * box is what base-ui treats as "inside the dialog" for outside-press dismissal
 * (see `DialogContent`), so it must be the width of the visible panel and no
 * wider. The panel then fills it (`w-full`).
 */
const DIALOG_SIZES = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-4xl",
} as const;

/**
 * How far below the top of the window the dialog sits, and the clearance it
 * keeps above the bottom.
 *
 * The offset was a bare `20vh`, which is a fraction of the window and so grows
 * without limit: on a tall display the dialog drifts ever further down the
 * screen, away from where the eye is. Capping it at `8rem` keeps the
 * proportional behaviour where it helps — a short window, where a fixed inset
 * would eat the room the dialog needs — and stops it where it stops helping.
 *
 * The bottom gap is the other half, and it is what makes the height HONEST: the
 * panel's `--available-height` is derived from both numbers, so the box can
 * never run past the bottom edge of the window. It used to be a separate `75vh`
 * that happened to leave 5vh under a 20vh offset — two numbers that had to be
 * kept in agreement by hand, and on a short window left the panel almost
 * touching the bottom.
 *
 * `dvh`, not `vh`: on a phone `vh` is the address-bar-less height, so a dialog
 * sized in `vh` is taller than the screen until the bar retracts.
 */
const DIALOG_TOP = "min(20vh, 8rem)";
const DIALOG_BOTTOM_GAP = "2rem";

type DialogContentProps = Omit<DialogPrimitive.Popup.Props, "className"> & {
  /**
   * Plain override class landing LAST on the panel. Narrower than base-ui's
   * `className`, which also accepts a `(state) => string` form: this class goes
   * to the inner `OverlayPanel`, which has no access to the popup's state (and
   * the state-driven variants live as `data-*` selectors in the panel's own
   * class bundle anyway).
   */
  className?: string;
  /** Panel width tier. Default "md". */
  size?: keyof typeof DIALOG_SIZES;
  /**
   * The ✕ in the corner. Default `true`, because Escape and the outside press
   * are both invisible — without it a dialog can offer the user no way out they
   * can SEE, which is exactly what a dialog must never do.
   *
   * Pass `false` only when the content already shows its own way out (the
   * command palette's "esc close" footer). Never because the dialog is
   * important: a dialog that must not be dismissed by a stray press says that
   * with `dismissible`, and needs this button MORE, not less, since it is then
   * the only visible exit.
   */
  showCloseButton?: boolean;
};

function DialogContent({
  className,
  children,
  size = "md",
  showCloseButton = true,
  ...props
}: DialogContentProps) {
  const forwarded = usePortalForwardedAttrs();
  return (
    <MenuSurfaceProvider value={false}>
      <DialogPortal>
        <DialogOverlay />
        {/* The popup's box IS the panel's box — never a full-viewport wrapper.
          base-ui dismisses on an outside press by asking "is the press target
          inside the floating element?", and the floating element is THIS node.
          A `fixed inset-0` popup with the panel centred inside it therefore
          answers yes to every press in the window, which is why this dialog
          used to be dismissable only with Escape. Centring is done with the
          box itself (`inset-x-*` + `mx-auto` against the width tier) so there
          is no wrapper left to swallow the press. */}
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          {...forwarded}
          // `inset-x-(--space-md)` rather than `inset-x-0`: at phone width the
          // panel is narrower than its tier's cap, so without it the box runs
          // edge to edge and the dialog reads as a page rather than as something
          // laid over one. The margin is inset, never padding — padding on the
          // popup would be dead area INSIDE the dialog's own box, which is the
          // full-viewport-wrapper bug in miniature.
          className={cn(
            "fixed inset-x-(--space-md) top-(--dialog-top) z-popover mx-auto outline-none",
            DIALOG_SIZES[size],
          )}
          style={
            {
              "--dialog-top": DIALOG_TOP,
              // Declared here, with the offset it is derived from, so the two can
              // no longer drift apart (see DIALOG_TOP). The panel inherits it.
              "--available-height": `calc(100dvh - ${DIALOG_TOP} - ${DIALOG_BOTTOM_GAP})`,
            } as React.CSSProperties
          }
          {...props}
        >
          {/* The dialog's box IS the shared panel — see `overlay-panel.tsx`. A
            dialog is CENTERED rather than anchored, so nothing positions it and
            no positioner publishes an `--available-height` for it; the popup
            above declares one from its own offset, which is what turns the
            panel's unconditional clamp into "as tall as the room actually
            left". Width comes from the popup too (`DIALOG_SIZES`) and the panel
            simply fills it: `POPOVER_WIDTH.content` (the default role) is the
            empty string, so the `w-full` here is unopposed.

            `padding="lg"` is FIXED, and there is no `padded` prop to switch it
            off: the panel owns the region's edge, so it owns the rail (see the
            rail contract in app.css). A flush caller does not turn the region
            off — the child that must reach the panel edge (a header band's
            rule, a footer's) says so itself with `rail-bleed`, which cancels
            and re-applies the rail as one indivisible act, so its content stays
            on the same rail as everything else. Absent-from-the-type rather
            than defaulted-in-it is the same move `ControlPanelPopover` makes
            with `width`: an escape that has no spelling cannot be reached for
            by accident.

            Two caveats before reaching for it. Bleed only a DIRECT child of the
            panel: the panel's own `overflow-x-hidden` is what makes a bleed free
            — inside a nested `ScrollArea` (viewport `overflow: scroll` on both
            axes) the same class buys sideways scroll instead of a wider box. And
            never put it in this component's own `className`, however much it
            looks like the replacement for the old `padded={false}`:
            `rail-bleed` is `extend px`, so it would REMOVE the `rail-lg` below
            it, leaving the panel un-inset (the intended half) and also bleeding
            against a rail that is now zero. */}
          <OverlayPanel
            data-slot="dialog-panel"
            padding="lg"
            className={cn("w-full", className)}
          >
            {children}
          </OverlayPanel>
          {showCloseButton && (
            // A SIBLING of the panel, not a child: the panel is the scroller, so a
            // button inside it would scroll away with the content and be clipped
            // by its overflow. As a sibling of a `fixed` popup it resolves against
            // the popup — which is now exactly the panel's box, so "the panel's
            // top-right corner" and "the popup's top-right corner" are one place.
            //
            // `z-popover` matches the panel rather than beating it: equal layers
            // paint in tree order and this comes second, so it lands on top
            // without claiming a rung above the whole popover layer.
            <DialogPrimitive.Close
              data-slot="dialog-close-corner"
              render={
                <Button
                  variant="ghost"
                  aspect="icon"
                  className="absolute top-3 right-3 z-popover"
                />
              }
            >
              <Icon icon={closeIcon} />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </MenuSurfaceProvider>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-heading text-subheading text-foreground", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-body text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
};
