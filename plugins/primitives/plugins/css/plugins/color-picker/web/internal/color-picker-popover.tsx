import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState, type ReactNode } from "react";
import { ColorPicker, type ColorPickerProps } from "./color-picker";

export interface ColorPickerPopoverProps extends ColorPickerProps {
  children?: ReactNode;
  contentClassName?: ClassName;
}

export function ColorPickerPopover({
  children,
  contentClassName,
  ...pickerProps
}: ColorPickerPopoverProps) {
  const [open, setOpen] = useState(false);
  // Bumped on every open: a fresh picker per open, so its "before" swatch is
  // the color this open started from, not the one the first open did.
  const [session, setSession] = useState(0);

  const trigger = children ?? (
    <button
      type="button"
      aria-label="Pick color"
      className={cn(
        "size-6 rounded-md border border-border outline-none transition-transform",
        "focus-visible:ring-2 focus-visible:ring-ring",
      )}
      style={{ background: pickerProps.value }}
    />
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setSession((n) => n + 1);
        setOpen(next);
      }}
    >
      <PopoverTrigger className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        width="content"
        // eslint-disable-next-line rail/no-unowned-overlay -- the ColorPicker is a complete card with its own panel inset
        padding="none"
        className={contentClassName}
        align="start"
      >
        <ColorPicker key={session} {...pickerProps} />
      </PopoverContent>
    </Popover>
  );
}
