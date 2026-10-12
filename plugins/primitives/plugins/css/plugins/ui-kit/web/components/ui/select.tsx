import * as React from "react";
import { MenuSurfaceProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/menu-surface";
import { Select as SelectPrimitive } from "@base-ui/react/select";

import {
  MENU_LABEL,
  MENU_ROW,
  MENU_SEPARATOR,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/menu-row";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils";
import { usePortalForwardedAttrs } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/portal-forward";
import { usePopupOpenMirror } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/popup-open-mirror";
import { OverlayPanel } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/overlay-panel";
import type {
  PopoverWidth,
  PopoverPadding,
  PopoverMaxHeight,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/popover-width";
import {
  fieldSizeClassFor,
  useControlSize,
  type DensityControlled,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size";
import { usePortalContainer } from "@plugins/primitives/plugins/overlay/plugins/portal-host/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const keyboardArrowDownIcon = symbol("keyboard-arrow-down");
const checkIcon = symbol("check");
const keyboardArrowUpIcon = symbol("keyboard-arrow-up");

// Kept generic over base-ui's own `<Value, Multiple>` params: this was a bare
// `const Select = SelectPrimitive.Root` alias, and a non-generic wrapper would
// silently erase value inference for every consumer selecting object values.
function Select<Value, Multiple extends boolean | undefined = false>({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: SelectPrimitive.Root.Props<Value, Multiple>) {
  // See `usePopupOpenMirror`: the enclosing PopupOpenScope reads this instead of
  // a CSS selector over base-ui's own open-state attribute.
  const { onOpenChange: handleOpenChange } = usePopupOpenMirror({
    open,
    defaultOpen,
    onOpenChange,
  });
  return (
    <SelectPrimitive.Root<Value, Multiple>
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={handleOpenChange}
      {...props}
    />
  );
}

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      // No inset of its own: the panel opens the region (see `SelectContent`),
      // so a group lives in it and its items land on the rail by doing nothing.
      className={cn("scroll-my-1", className)}
      {...props}
    />
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("flex flex-1 text-left", className)}
      {...props}
    />
  );
}

function SelectTrigger({
  className,
  children,
  ...props
}: SelectPrimitive.Trigger.Props & DensityControlled) {
  // The same ambient field bundle as `Input` (`fieldSizeClassFor`): height,
  // inline padding, gap and text follow the control density, so a select sits
  // level with the buttons and inputs in its row. The compact sizes clamp their
  // corner like `Button`'s xs/sm do.
  const density = useControlSize();
  const compact = density === "xs" || density === "sm";
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      // eslint-disable-next-line radius/no-adhoc-radius -- intentional min() clamp pins the compact corner so it never exceeds 10px regardless of Shape preset
      className={cn(
        "focus-ring flex w-fit items-center justify-between rounded-lg border border-input bg-transparent whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-faint-foreground *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-inherit dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        fieldSizeClassFor(density),
        compact && "rounded-[min(var(--radius-md),10px)]",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <Icon
            icon={keyboardArrowDownIcon}
            className="pointer-events-none size-4 text-muted-foreground"
          />
        }
      />
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  header,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  width = "anchor-min",
  padding = "xs",
  maxHeight = "viewport",
  ...props
}: Omit<SelectPrimitive.Popup.Props, "render" | "className"> &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  > & {
    /**
     * Plain override class landing LAST on the panel. Narrower than base-ui's
     * `className`, which also accepts a `(state) => string` form: the panel is
     * composed by `OverlayPanel`, which has no access to the popup's state, and
     * the state-driven variants are already expressed as `data-*` selectors in
     * the panel's own class bundle.
     */
    className?: string;
    /**
     * Closed width role; default `anchor-min` — at least the trigger's width
     * (the list opens over the value it lists) and at least a menu's minimum
     * (`popoverWidthMenuMin`), so a listbox under a narrow trigger is still as
     * wide as any other menu.
     */
    width?: PopoverWidth;
    /**
     * Padding role; default `xs` — the panel OPENS the region and items live in
     * it. (It used to default to `none` and let `SelectGroup` inset the rows
     * instead: the same inversion the rail contract exists to delete, since a
     * raw child dropped beside a group then sat flush against the panel edge.)
     */
    padding?: PopoverPadding;
    /**
     * Max-height COMFORT CAP on top of the unconditional viewport fit; default
     * `viewport` (fit the space Floating UI measured, and nothing tighter).
     */
    maxHeight?: PopoverMaxHeight;
    /** Optional sticky header rendered above the item list (not a focusable item). */
    header?: React.ReactNode;
  }) {
  const forwarded = usePortalForwardedAttrs();
  // Inside a PortalHost (a fullscreen region), draw there: under `body` the
  // popup would be invisible.
  const container = usePortalContainer();
  return (
    <MenuSurfaceProvider value={true}>
      <SelectPrimitive.Portal container={container}>
        <SelectPrimitive.Positioner
          {...forwarded}
          side={side}
          sideOffset={sideOffset}
          align={align}
          alignOffset={alignOffset}
          alignItemWithTrigger={alignItemWithTrigger}
          className="isolate z-popover"
        >
          {/* The popup IS the shared panel (see `overlay-panel.tsx`); `{...props}`
            stays BEFORE `render` and `render` is `Omit`ed from the public prop
            type, so a caller can never replace it.

            The arrows and the list stay DIRECT children of the panel, and the
            header stays a plain child rather than `OverlayPanel`'s `header` prop:
            with `alignItemWithTrigger` (the default) `SelectPopup` writes
            `height: 100%` onto the popup and `max-height: 100%` onto the list, so
            any intervening auto-height box would break that percentage chain,
            and the arrows are `position: absolute` against the panel's own
            `relative`. It carries `rail-bleed` instead of the `header` prop's
            fixed negative margins, so its rule spans the panel at whatever
            padding role the panel is actually on. */}
          <SelectPrimitive.Popup
            data-slot="select-content"
            data-align-trigger={alignItemWithTrigger}
            {...props}
            render={
              <OverlayPanel
                width={width}
                padding={padding}
                maxHeight={maxHeight}
                className={cn(
                  // `relative` is the arrows' containing block; `isolate` keeps the
                  // sticky header / arrows stacking inside the panel. The
                  // animate-none is genuinely Select-specific: with
                  // `alignItemWithTrigger` base-ui places the popup by measuring it,
                  // so a zoom/slide entrance would fight its own measurement.
                  "relative isolate data-[align-trigger=true]:animate-none",
                  className,
                )}
              >
                <SelectScrollUpButton />
                {header != null && (
                  <div className="sticky top-0 z-raised border-b bg-popover rail-bleed py-xs">
                    {header}
                  </div>
                )}
                <SelectPrimitive.List>{children}</SelectPrimitive.List>
                <SelectScrollDownButton />
              </OverlayPanel>
            }
          />
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </MenuSurfaceProvider>
  );
}

function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn(MENU_LABEL, className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        // The shared menu row (`theme/menu-row.ts`); only the grid and the
        // highlight's state model are the select's own.
        MENU_ROW,
        "grid grid-cols-[minmax(0,1fr)_auto] items-center data-highlighted:menu-row-lit *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-sm",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 truncate lead-icon-sm [&>svg]:inline-block [&>svg]:shrink-0 [&>svg]:align-middle">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none flex size-4 items-center justify-center" />
        }
      >
        <Icon
          icon={checkIcon}
          className="pointer-events-none text-primary-text"
        />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn(MENU_SEPARATOR, "pointer-events-none", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-raised flex w-full cursor-default items-center justify-center bg-popover py-xs [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <Icon icon={keyboardArrowUpIcon} />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-raised flex w-full cursor-default items-center justify-center bg-popover py-xs [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <Icon icon={keyboardArrowDownIcon} />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
