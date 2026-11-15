import * as React from "react";

import {
  usePublishOpenPopup,
  useReportPopupOpen,
} from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";

/**
 * Publishes a base-ui `Root`'s open state to the enclosing `PopupOpenScope`,
 * and page-wide (`usePublishOpenPopup`).
 *
 * This is the ONLY place in the repo that reads a popup library's open state on
 * behalf of surrounding chrome — consumers get the typed boolean out of
 * `PopupOpenScope` instead of a CSS selector naming base-ui's `data-popup-open`
 * attribute (which is how the previous, dead Radix spelling rotted unnoticed).
 *
 * Returns the `onOpenChange` to hand back to the `Root`, and whether the popup
 * is open now. The caller's handler is invoked with EVERY argument base-ui passed — the signature is
 * `(open, eventDetails)` today and the spread keeps this wrapper transparent to
 * whatever it becomes.
 */
export function usePopupOpenMirror<Args extends unknown[]>({
  open,
  defaultOpen,
  onOpenChange,
}: {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean, ...args: Args) => void) | undefined;
}): {
  onOpenChange: (open: boolean, ...args: Args) => void;
  isOpen: boolean;
} {
  const [mirrored, setMirrored] = React.useState(defaultOpen ?? false);

  // A controlled `open` is the truth whenever it is supplied; the mirror only
  // stands in for the uncontrolled case, where base-ui keeps the state itself.
  const isOpen = open ?? mirrored;
  useReportPopupOpen(isOpen);
  usePublishOpenPopup(isOpen);

  return {
    onOpenChange: (nextOpen, ...rest) => {
      setMirrored(nextOpen);
      onOpenChange?.(nextOpen, ...rest);
    },
    isOpen,
  };
}
