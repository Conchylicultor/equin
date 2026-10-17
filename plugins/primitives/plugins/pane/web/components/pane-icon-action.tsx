import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";

interface PaneIconActionProps extends Omit<
  ComponentProps<typeof IconButton>,
  "icon" | "label"
> {
  label: string;
  icon?: IconRef;
  children?: ReactNode;
}

export const PaneIconAction = forwardRef<
  HTMLButtonElement,
  PaneIconActionProps
>(function PaneIconAction({ label, icon: Icon, children, ...rest }, ref) {
  // A bare Button defaults to the TEXT shape; `aspect="icon"` forces the square
  // icon shape (at the ambient density) so custom-children actions match the icon
  // buttons beside them.
  if (children && !Icon) {
    return (
      <Button
        tooltip={label}
        ref={ref}
        variant="ghost"
        aspect="icon"
        aria-label={label}
        {...rest}
      >
        {children}
      </Button>
    );
  }
  // `rest` carries the whole handler set, not just `onClick` — the promote
  // action drives a link gesture (cmd-click / middle-click open a new tab), so
  // it hands over `onAuxClick`/`onMouseDown` too.
  return <IconButton ref={ref} icon={Icon!} label={label} {...rest} />;
});
