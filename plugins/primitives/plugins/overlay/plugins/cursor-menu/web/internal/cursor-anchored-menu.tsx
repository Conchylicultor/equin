import { createPortal } from "react-dom";
import type { ComponentProps, ReactNode } from "react";
import { renderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

export interface CursorAnchor {
  x: number;
  y: number;
}

export interface CursorAnchoredMenuProps {
  /** Open point in VIEWPORT coords (e.clientX/clientY); null = closed. */
  anchor: CursorAnchor | null;
  onClose: () => void;
  /** DropdownMenuItem / Sub / Separator / CheckboxItem … */
  children: ReactNode;
  align?: ComponentProps<typeof DropdownMenuContent>["align"];
  side?: ComponentProps<typeof DropdownMenuContent>["side"];
}

/**
 * A DropdownMenu whose zero-size trigger is pinned at a cursor point. The trigger
 * is portaled to document.body so its `position: fixed` resolves against the real
 * viewport — NOT against a transformed ancestor (e.g. the surface backdrop's
 * `transform-gpu`, which would otherwise become the containing block and shift the
 * menu). createPortal moves only the DOM node; the trigger stays in the React tree
 * under <DropdownMenu>, so base-ui Menu context is intact. DropdownMenuContent
 * already self-portals + theme-forwards, so no extra wiring is needed.
 */
export function CursorAnchoredMenu(props: CursorAnchoredMenuProps) {
  // A static render (HTML for robots, never hydrated) has no `document.body`
  // to pin the trigger in, and a menu no click can open is not page content.
  if (renderMode() === "static") return null;
  return <LiveCursorAnchoredMenu {...props} />;
}

function LiveCursorAnchoredMenu({
  anchor,
  onClose,
  children,
  align = "start",
  side = "bottom",
}: CursorAnchoredMenuProps) {
  return (
    <DropdownMenu
      open={anchor !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {createPortal(
        <DropdownMenuTrigger
          aria-hidden
          tabIndex={-1}
          style={{
            position: "fixed",
            left: anchor?.x ?? 0,
            top: anchor?.y ?? 0,
            width: 0,
            height: 0,
          }}
        />,
        document.body,
      )}
      <DropdownMenuContent align={align} side={side}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
