import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  CursorAnchoredMenu,
  type CursorAnchor,
} from "@plugins/primitives/plugins/overlay/plugins/cursor-menu/web";
import { PopupTheme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { formatShortcutLabel } from "@plugins/primitives/plugins/shortcuts/web";
import { desktopThemeScope } from "@plugins/apps/plugins/desktop/plugins/shell/web";
import type { AppIcon } from "@plugins/apps-core/plugins/app-icon/core";
import type {
  Desktop,
  Geometry,
  WindowId,
} from "../hooks/use-floating-windows";
import type { SnapZone } from "../hooks/use-snap";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { WindowAppTile } from "./window-app-tile";

const addIcon = symbol("add");
const callSplitIcon = symbol("call-split");
const checkIcon = symbol("check");
const closeIcon = symbol("close");
const cropSquareIcon = symbol("crop-square");
const desktopWindowsIcon = symbol("desktop-windows");
const filterNoneIcon = symbol("filter-none");
const fullscreenIcon = symbol("fullscreen");
const keepIcon = symbol("keep");
const removeIcon = symbol("remove");
const splitSceneIcon = symbol("splitscreen-left");
const tabMoveIcon = symbol("tab-move");

/** Another window of this desktop, offered in the "Merge tab into ▸" submenu. */
export interface MergeTarget {
  id: WindowId;
  /** Its shown tab's app, the item's "App — title" and tile. */
  appName: string;
  appIcon: AppIcon | undefined;
  /** Its shown tab's title. */
  title: string;
}

/** The window shortcuts the chrome and the menu name — the keys registered in the barrel. */
export const TOGGLE_PIN_SHORTCUT = "ctrl+alt+p";
export const MINIMIZE_SHORTCUT = "mod+m";
export const MAXIMIZE_SHORTCUT = "ctrl+alt+arrowup";
export const SNAP_LEFT_SHORTCUT = "ctrl+alt+arrowleft";
export const SNAP_RIGHT_SHORTCUT = "ctrl+alt+arrowright";
export const CLOSE_SHORTCUT = "mod+w";

/** A viewport-space point the menu opens at (right-click cursor or app-button corner). */
export type MenuAnchor = CursorAnchor;

interface WindowSystemMenuProps {
  /** The open point, or null when the menu is closed. */
  anchor: MenuAnchor | null;
  onClose: () => void;
  geo: Geometry;
  /** Snap to a zone, or back to the free box with `null` (Restore). */
  onSnap: (zone: SnapZone | null) => void;
  onMinimize: () => void;
  /** Maximise, or unmaximise a maximised window. */
  onMaximize: () => void;
  onFullscreen: () => void;
  onTogglePin: () => void;
  onCloseWindow: () => void;
  /** Other windows of this desktop this window's active tab can be merged into. */
  mergeTargets: MergeTarget[];
  /** Merge this window's active tab into the given target window. */
  onMergeInto: (targetWindowId: WindowId) => void;
  /** Whether the window holds >1 member, so its active tab can be torn off. */
  canSplit: boolean;
  /** Tear this window's active tab out into a new window. */
  onSplit: () => void;
  /** Every virtual desktop, for the "Move to desktop ▸" submenu. */
  desktops: Desktop[];
  /** The desktop this window currently lives on (checked). */
  currentDesktopId: string;
  /** Move this window to an existing desktop. */
  onMoveToDesktop: (desktopId: string) => void;
  /** Move this window to a freshly-created desktop. */
  onMoveToNewDesktop: () => void;
}

/** The snap submenu's quarters (mockup order, no key hints). */
const QUARTERS: ReadonlyArray<{ zone: SnapZone; label: string }> = [
  { zone: "top-left", label: "Top left" },
  { zone: "top-right", label: "Top right" },
  { zone: "bottom-left", label: "Bottom left" },
  { zone: "bottom-right", label: "Bottom right" },
];

/**
 * The window menu — the mockup's `windowMenu`, in its order: Restore,
 * Minimise, Maximise / Unmaximise, Full screen | Keep on top | Snap ▸ (halves,
 * then quarters) | Move to desktop ▸ (each desktop, then New desktop), Merge
 * tab into ▸ (the desktop's other windows), Move tab to new window | Close
 * window. Opened by the titlebar's app button or a right-click on the bar.
 *
 * Built on {@link CursorAnchoredMenu} (a body-portaled anchor at the open
 * point, so the menu sits off the cursor like a native context menu), and worn
 * in the desktop's theme — the menu is desktop chrome, not the window's app.
 *
 * Item availability mirrors the chrome's state: Restore is live only for a
 * snapped window, Move tab to new window only with more than one tab.
 */
export function WindowSystemMenu({
  anchor,
  onClose,
  geo,
  onSnap,
  onMinimize,
  onMaximize,
  onFullscreen,
  onTogglePin,
  onCloseWindow,
  mergeTargets,
  onMergeInto,
  canSplit,
  onSplit,
  desktops,
  currentDesktopId,
  onMoveToDesktop,
  onMoveToNewDesktop,
}: WindowSystemMenuProps) {
  const maximized = geo.snap === "maximize";

  return (
    <PopupTheme name={desktopThemeScope}>
      <CursorAnchoredMenu anchor={anchor} onClose={onClose}>
        <DropdownMenuItem
          disabled={geo.snap === null}
          onClick={() => onSnap(null)}
        >
          <Icon icon={filterNoneIcon} />
          Restore
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onMinimize}>
          <Icon icon={removeIcon} />
          Minimise
          <DropdownMenuShortcut>
            {formatShortcutLabel(MINIMIZE_SHORTCUT)}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onMaximize}>
          <Icon icon={cropSquareIcon} />
          {maximized ? "Unmaximise" : "Maximise"}
          <DropdownMenuShortcut>
            {formatShortcutLabel(MAXIMIZE_SHORTCUT)}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onFullscreen}>
          <Icon icon={fullscreenIcon} />
          Full screen
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* A plain item whose icon turns into the check when on (the mockup's
            menu): a checkbox item draws its own indicator and has no room
            for the key hint. */}
        <DropdownMenuItem onClick={onTogglePin}>
          <Icon icon={geo.pinned ? checkIcon : keepIcon} />
          Keep on top
          <DropdownMenuShortcut>
            {formatShortcutLabel(TOGGLE_PIN_SHORTCUT)}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Icon icon={splitSceneIcon} />
            Snap
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => onSnap("left")}>
              Left half
              <DropdownMenuShortcut>
                {formatShortcutLabel(SNAP_LEFT_SHORTCUT)}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSnap("right")}>
              Right half
              <DropdownMenuShortcut>
                {formatShortcutLabel(SNAP_RIGHT_SHORTCUT)}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {QUARTERS.map((q) => (
              <DropdownMenuItem key={q.zone} onClick={() => onSnap(q.zone)}>
                {q.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        {/* Send the whole window to another virtual desktop (or a new one). */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Icon icon={desktopWindowsIcon} />
            Move to desktop
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {desktops.map((desktop, index) => (
              <DropdownMenuCheckboxItem
                key={desktop.id}
                checked={desktop.id === currentDesktopId}
                disabled={desktop.id === currentDesktopId}
                onClick={() => onMoveToDesktop(desktop.id)}
              >
                {`Desktop ${index + 1}`}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onMoveToNewDesktop}>
              <Icon icon={addIcon} />
              New desktop
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {/* Grouping: fold the active tab into another window, or tear it out. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Icon icon={tabMoveIcon} />
            Merge tab into
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {mergeTargets.length > 0 ? (
              mergeTargets.map((target) => (
                <DropdownMenuItem
                  key={target.id}
                  onClick={() => onMergeInto(target.id)}
                >
                  <WindowAppTile icon={target.appIcon} size={16} radius={4} />
                  {`${target.appName} — ${target.title}`}
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled>No other windows</DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem disabled={!canSplit} onClick={onSplit}>
          <Icon icon={callSplitIcon} />
          Move tab to new window
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Closes the WHOLE window (every member); per-tab close is the chip ×
            and the `mod+w` shortcut, which act on the active member alone. */}
        <DropdownMenuItem variant="destructive" onClick={onCloseWindow}>
          <Icon icon={closeIcon} />
          Close window
          <DropdownMenuShortcut>
            {formatShortcutLabel(CLOSE_SHORTCUT)}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
      </CursorAnchoredMenu>
    </PopupTheme>
  );
}
