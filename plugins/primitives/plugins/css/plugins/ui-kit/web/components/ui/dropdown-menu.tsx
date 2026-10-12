import * as React from "react";
import { MenuSurfaceProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/menu-surface";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils";
import { usePortalForwardedAttrs } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/portal-forward";
import { usePopupOpenMirror } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/popup-open-mirror";
import { useFrameFocusDismiss } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/frame-focus-dismiss";
import { OverlayPanel } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/overlay-panel";
import type {
  PopoverWidth,
  PopoverPadding,
  PopoverMaxHeight,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/popover-width";
import {
  MENU_LABEL,
  MENU_ROW,
  MENU_ROW_TRAIL,
  MENU_SEPARATOR,
  MENU_VALUE,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/menu-row";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/button";
import { usePortalContainer } from "@plugins/primitives/plugins/overlay/plugins/portal-host/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const chevronRightIcon = symbol("chevron-right");
const checkIcon = symbol("check");

function DropdownMenu({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: Omit<MenuPrimitive.Root.Props, "actionsRef">) {
  // Publish open state to the enclosing PopupOpenScope, so chrome that must
  // hold itself visible while its menu is open (a hover-revealed row-action
  // cluster — the menu's own anchor) reads a typed boolean.
  const { onOpenChange: handleOpenChange, isOpen } = usePopupOpenMirror({
    open,
    defaultOpen,
    onOpenChange,
  });
  // A click inside an iframe never reaches base-ui's outside-press listener.
  const actionsRef = useFrameFocusDismiss<MenuPrimitive.Root.Actions>(isOpen);
  return (
    <MenuPrimitive.Root
      data-slot="dropdown-menu"
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={handleOpenChange}
      actionsRef={actionsRef}
      {...props}
    />
  );
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  const container = usePortalContainer();
  return (
    <MenuPrimitive.Portal
      data-slot="dropdown-menu-portal"
      container={container}
      {...props}
    />
  );
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  width = "menu-fit",
  padding = "xs",
  maxHeight = "viewport",
  className,
  header,
  children,
  ...props
}: Omit<MenuPrimitive.Popup.Props, "render" | "className"> &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
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
     * Closed width role; default `menu-fit` — sized to the items, between
     * the theme's menu bounds (`popoverWidthMenuMin` / `popoverWidthMenuMax`),
     * and never the trigger's width (a menu hung off a wide trigger is still a menu). A
     * picker standing in for a field passes `anchor-min` to keep at least its
     * trigger's width.
     */
    width?: PopoverWidth;
    /** Padding role; default `xs` (the previously baked-in menu padding). */
    padding?: PopoverPadding;
    /**
     * Max-height COMFORT CAP on top of the unconditional viewport fit; default
     * `viewport` (fit the space Floating UI measured, and nothing tighter).
     */
    maxHeight?: PopoverMaxHeight;
    /** Optional sticky header rendered above the items (skipped by keyboard nav — not an Item). */
    header?: React.ReactNode;
  }) {
  const forwarded = usePortalForwardedAttrs();
  // Inside a PortalHost (a fullscreen region), draw there: under `body` the
  // popup would be invisible.
  const container = usePortalContainer();
  return (
    <MenuSurfaceProvider value={true}>
      <MenuPrimitive.Portal container={container}>
        <MenuPrimitive.Positioner
          {...forwarded}
          className="isolate z-popover outline-none"
          align={align}
          alignOffset={alignOffset}
          side={side}
          sideOffset={sideOffset}
        >
          {/* The popup IS the shared panel: base-ui owns the state machine, and
            `render` hands it `OverlayPanel` as the element to clone its merged
            props onto (`{...props}` stays BEFORE `render`, and `render` is
            `Omit`ed from the public prop type, so a caller can never replace the
            panel). Chrome, geometry, viewport fit and the content-context resets
            all live in one place — see `overlay-panel.tsx`. */}
          <MenuPrimitive.Popup
            data-slot="dropdown-menu-content"
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
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuSurfaceProvider>
  );
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(MENU_LABEL, "data-inset:pl-xl", className)}
      {...props}
    />
  );
}

/**
 * A labelled menu section: the `Group` + `GroupLabel` pair rendered together as
 * one unit. Base-ui's `Menu.GroupLabel` (our `DropdownMenuLabel`) requires an
 * ancestor `Menu.Group` context — a groupless label throws a hard runtime error
 * (#31 `useMenuGroupRootContext`) that white-screens the menu. This composed
 * primitive makes that coupling structurally impossible: the label always sits
 * inside its group, alongside the section's items (so `aria-labelledby` is
 * correct). Prefer this over a hand-rolled `DropdownMenuGroup` + `DropdownMenuLabel`
 * for any labelled section; the `no-groupless-dropdown-menu-label` lint rule
 * enforces it.
 */
function DropdownMenuSection({
  label,
  inset,
  action,
  children,
  ...props
}: MenuPrimitive.Group.Props & {
  /** The section heading, rendered as the group's `GroupLabel`. */
  label: React.ReactNode;
  /** Indent the label to align with inset items. */
  inset?: boolean;
  /**
   * A section-wide action pinned to the heading's trailing edge — "configure
   * where these rows come from". Always visible (a row's action reveals on
   * highlight; a heading is never highlighted), and kept OUTSIDE the
   * `GroupLabel` so the group's accessible name stays the heading text alone.
   */
  action?: MenuRowAction;
}) {
  return (
    <DropdownMenuGroup {...props}>
      {action ? (
        <span className="flex items-center gap-sm pr-2xs">
          <DropdownMenuLabel inset={inset} className="min-w-0 flex-1">
            {label}
          </DropdownMenuLabel>
          <MenuSectionAction action={action} />
        </span>
      ) : (
        <DropdownMenuLabel inset={inset}>{label}</DropdownMenuLabel>
      )}
      {children}
    </DropdownMenuGroup>
  );
}

/**
 * A section heading's trailing action: the menu row action's look, always
 * shown. It is a menu ITEM rendered as that button, so the arrow keys reach it
 * and activating it closes the menu like any other command — the action
 * usually navigates away (to the settings behind the rows), and a menu left
 * hanging over its destination would hide it.
 */
function MenuSectionAction({ action }: { action: MenuRowAction }) {
  return (
    <ControlSizeProvider size="xs">
      <MenuPrimitive.Item
        aria-label={action.label}
        title={action.label}
        data-slot="dropdown-menu-section-action"
        onClick={(e) => action.onAction(e)}
        render={
          // Keyboard highlight moves focus onto it, so the Button's own focus
          // ring marks it — no menu-row paint for a heading's icon button.
          <Button variant="ghost" aspect="icon" />
        }
      >
        <Icon icon={action.icon} />
      </MenuPrimitive.Item>
    </ControlSizeProvider>
  );
}

/**
 * A row's own action, revealed while the row is highlighted (pointer OR
 * keyboard): a one-time variant of what the row does — the model picker's
 * "launch this model now" beside "make it the default". The row draws it, at
 * the `xs` control density, so it fits inside the row's height and every
 * menu's action looks the same; a click on it never selects the row.
 */
export interface MenuRowAction {
  icon: IconRef;
  /** The action's name: its aria-label and hover title. */
  label: string;
  /** May return a promise: the button shows its pending state until it settles. */
  onAction: (e: React.MouseEvent) => unknown;
}

/**
 * The trailing parts a row may carry, shared by every item kind: a hover
 * action, then a keyboard shortcut (plain faint text — the menu's value style,
 * never a keycap). The check mark of a checkbox / radio item follows them.
 */
interface MenuRowTrailProps {
  /** A keyboard shortcut label, already formatted (`formatShortcutLabel`). */
  shortcut?: string;
  action?: MenuRowAction;
}

function MenuRowTrailParts({ shortcut, action }: MenuRowTrailProps) {
  return (
    <>
      {action && (
        // A zero-height box centred on the row's line: the button overflows it
        // evenly, so a row with an action is exactly as tall as one without
        // (the `xs` box is shorter than `--panel-row-h`, but not than the
        // row's content box once its block pad is counted).
        <span className="flex h-0 items-center">
          <ControlSizeProvider size="xs">
            {/* eslint-disable-next-line icon-button/prefer-icon-button -- ui-kit sits below the icon-button primitive; the menu row owns its action's one look */}
            <Button
              variant="ghost"
              aspect="icon"
              tabIndex={-1}
              aria-label={action.label}
              title={action.label}
              data-slot="dropdown-menu-item-action"
              // `transition-colors`, not the Button's `transition-all`: that
              // also animates `visibility`, which kept the action showing on
              // a row the highlight had already left.
              className="invisible transition-colors group-data-highlighted/menu-row:visible"
              onClick={(e) => {
                e.stopPropagation();
                return action.onAction(e);
              }}
            >
              <Icon icon={action.icon} />
            </Button>
          </ControlSizeProvider>
        </span>
      )}
      {shortcut && (
        <span data-slot="dropdown-menu-shortcut" className={MENU_VALUE}>
          {shortcut}
        </span>
      )}
    </>
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  shortcut,
  action,
  children,
  ...props
}: MenuPrimitive.Item.Props &
  MenuRowTrailProps & {
    inset?: boolean;
    variant?: "default" | "destructive";
  }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        // The shared menu row (`theme/menu-row.ts`): geometry, paint, the
        // destructive tone (keyed on `data-variant`) and disabled. Only the
        // layout and the highlight's state model are this component's.
        MENU_ROW,
        "relative flex items-center data-highlighted:menu-row-lit data-inset:pl-xl",
        className,
      )}
      {...props}
    >
      {children}
      {(shortcut || action) && (
        <span className={MENU_ROW_TRAIL}>
          <MenuRowTrailParts shortcut={shortcut} action={action} />
        </span>
      )}
    </MenuPrimitive.Item>
  );
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        // An open submenu keeps its trigger lit while the pointer is inside it.
        MENU_ROW,
        "flex items-center data-highlighted:menu-row-lit data-popup-open:menu-row-lit data-inset:pl-xl",
        className,
      )}
      {...props}
    >
      {children}
      <span className={MENU_ROW_TRAIL}>
        <Icon icon={chevronRightIcon} />
      </span>
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  // Same role as the menu it opened from, so a submenu sizes like every
  // other menu (its "anchor" is one row of the parent, never a width to match).
  width = "menu-fit",
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      width={width}
      // Only the shadow step differs from the shared panel — a submenu floats one
      // level above the menu it opened from. Everything else (surface bundle,
      // animation, padding) comes from `OverlayPanel`; re-declaring it here was a
      // second copy of the same bundle layered on the first.
      className={cn("shadow-lg", className)}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  shortcut,
  action,
  ...props
}: MenuPrimitive.CheckboxItem.Props &
  MenuRowTrailProps & {
    inset?: boolean;
  }) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        MENU_ROW,
        "grid grid-cols-[minmax(0,1fr)_auto] items-center data-highlighted:menu-row-lit data-inset:pl-xl",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="min-w-0 truncate lead-icon-sm [&>svg]:inline-block [&>svg]:shrink-0 [&>svg]:align-middle">
        {children}
      </span>
      <span className={MENU_ROW_TRAIL}>
        <MenuRowTrailParts shortcut={shortcut} action={action} />
        <span
          className="pointer-events-none flex size-4 items-center justify-center"
          data-slot="dropdown-menu-checkbox-item-indicator"
        >
          <MenuPrimitive.CheckboxItemIndicator>
            <Icon icon={checkIcon} className="text-primary-text" />
          </MenuPrimitive.CheckboxItemIndicator>
        </span>
      </span>
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return (
    <MenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  shortcut,
  action,
  ...props
}: MenuPrimitive.RadioItem.Props &
  MenuRowTrailProps & {
    inset?: boolean;
  }) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        MENU_ROW,
        "grid grid-cols-[minmax(0,1fr)_auto] items-center data-highlighted:menu-row-lit data-inset:pl-xl",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate lead-icon-sm [&>svg]:inline-block [&>svg]:shrink-0 [&>svg]:align-middle">
        {children}
      </span>
      <span className={MENU_ROW_TRAIL}>
        <MenuRowTrailParts shortcut={shortcut} action={action} />
        <span
          className="pointer-events-none flex size-4 items-center justify-center"
          data-slot="dropdown-menu-radio-item-indicator"
        >
          <MenuPrimitive.RadioItemIndicator>
            <Icon icon={checkIcon} className="text-primary-text" />
          </MenuPrimitive.RadioItemIndicator>
        </span>
      </span>
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(MENU_SEPARATOR, className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(MENU_VALUE, "ml-auto", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSection,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
