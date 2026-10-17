import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type {
  PopoverWidth,
  PopoverPadding,
  PopoverMaxHeight,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ComponentProps } from "react";

type ContentPositionerProps = Pick<
  ComponentProps<typeof PopoverContent>,
  "align" | "side" | "finalFocus" | "resetOnClose"
>;

export interface InlinePopoverProps extends ContentPositionerProps {
  /** Trigger element — open/close behavior is merged via base-ui render prop. */
  trigger: React.ReactElement;
  /** Popover panel content. */
  children: React.ReactNode;
  /** Optional tooltip shown on trigger hover. */
  tooltip?: React.ReactNode;
  /** Closed width role forwarded to PopoverContent; default size-to-content. */
  width?: PopoverWidth;
  /** Padding role forwarded to PopoverContent; default `md`. */
  padding?: PopoverPadding;
  /**
   * Max-height COMFORT CAP forwarded to PopoverContent; default `viewport`.
   * The panel already fits the viewport and scrolls unconditionally — this only
   * makes a long list SHORTER than the space it has, so it opens as a menu-sized
   * box instead of a viewport-tall wall.
   */
  maxHeight?: PopoverMaxHeight;
  /**
   * Extra classes forwarded to PopoverContent. Must NOT carry width, padding or
   * max-height — use the `width` / `padding` / `maxHeight` props instead.
   */
  contentClassName?: ClassName;
  /** Controlled open state — omit for uncontrolled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function InlinePopover({
  trigger,
  children,
  tooltip,
  align = "start",
  side = "bottom",
  width,
  padding,
  maxHeight,
  contentClassName,
  finalFocus,
  resetOnClose,
  open,
  onOpenChange,
}: InlinePopoverProps) {
  const triggerNode = <PopoverTrigger render={trigger} />;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {tooltip ? (
        <WithTooltip content={tooltip}>{triggerNode}</WithTooltip>
      ) : (
        triggerNode
      )}
      <PopoverContent
        align={align}
        side={side}
        width={width}
        padding={padding}
        maxHeight={maxHeight}
        finalFocus={finalFocus}
        resetOnClose={resetOnClose}
        className={contentClassName}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
