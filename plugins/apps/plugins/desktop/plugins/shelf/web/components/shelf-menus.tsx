import {
  DropdownMenuItem,
  DropdownMenuSection,
  DropdownMenuSeparator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  CursorAnchoredMenu,
  type CursorAnchor,
} from "@plugins/primitives/plugins/overlay/plugins/cursor-menu/web";
import type { FloatingWindow } from "@plugins/apps/plugins/desktop/plugins/windows/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { ShelfActions, ShelfAppEntry } from "../internal/use-shelf-model";

const addIcon = symbol("add");
const checkIcon = symbol("check");
const closeIcon = symbol("close");
const desktopIcon = symbol("desktop-windows");
const keepIcon = symbol("keep");
const minimizeIcon = symbol("minimize");
const windowIcon = symbol("web-asset");

/**
 * Where a shelf menu opens: centred over the element it belongs to, 10px above
 * it (mockup `{ x: center, y: top - 10, above, center }`).
 */
export function menuAnchorAbove(el: HTMLElement): CursorAnchor {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top - 10 };
}

/**
 * An app entry's right-click menu (mockup `appMenu`): the app's name over a
 * row per window (the focused one checked), New window, Keep in dock / Remove
 * from dock, then — with windows — Minimise / Restore for a lone window and
 * Close window(s).
 */
export function AppMenu({
  anchor,
  entry,
  windows,
  focusedWindowId,
  titleOf,
  actions,
  onClose,
}: {
  anchor: CursorAnchor | null;
  entry: ShelfAppEntry | undefined;
  windows: FloatingWindow[];
  focusedWindowId: string | null;
  titleOf: (w: FloatingWindow) => string;
  actions: ShelfActions;
  onClose: () => void;
}) {
  const single = windows.length === 1 ? windows[0] : undefined;
  return (
    <CursorAnchoredMenu
      anchor={entry ? anchor : null}
      onClose={onClose}
      side="top"
      align="center"
    >
      {entry && (
        <>
          <DropdownMenuSection label={entry.app.app.name}>
            {windows.map((w) => {
              const focused = w.id === focusedWindowId;
              return (
                <DropdownMenuItem
                  key={w.id}
                  onClick={() =>
                    actions.runWindowAction(
                      w.geo.minimized
                        ? { kind: "restore", windowId: w.id }
                        : { kind: "focus", windowId: w.id },
                    )
                  }
                >
                  <Icon
                    icon={focused ? checkIcon : windowIcon}
                    className={focused ? "text-primary-text" : undefined}
                  />
                  {titleOf(w)}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuSection>
          {windows.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem
            shortcut="⇧ click"
            onClick={() => actions.openWindow(entry.appId)}
          >
            <Icon icon={addIcon} />
            New window
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => actions.togglePinned(entry.appId)}>
            <Icon icon={keepIcon} />
            {entry.pinned ? "Remove from dock" : "Keep in dock"}
          </DropdownMenuItem>
          {windows.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {single && (
                <DropdownMenuItem
                  onClick={() =>
                    actions.runWindowAction({
                      kind: single.geo.minimized ? "restore" : "minimize",
                      windowId: single.id,
                    })
                  }
                >
                  <Icon icon={minimizeIcon} />
                  {single.geo.minimized ? "Restore" : "Minimise"}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  for (const w of windows) actions.closeWindow(w.id);
                }}
              >
                <Icon icon={closeIcon} />
                {windows.length > 1
                  ? `Close ${windows.length} windows`
                  : "Close window"}
              </DropdownMenuItem>
            </>
          )}
        </>
      )}
    </CursorAnchoredMenu>
  );
}

/**
 * A mini-desktop's right-click menu (mockup pager `contextmenu`): the
 * desktop's name, Switch to (off for the current one), New desktop, Close
 * desktop (off for the last one).
 */
export function DesktopMenu({
  anchor,
  label,
  current,
  closable,
  onSwitch,
  onNew,
  onCloseDesktop,
  onClose,
}: {
  anchor: CursorAnchor | null;
  label: string;
  current: boolean;
  closable: boolean;
  onSwitch: () => void;
  onNew: () => void;
  onCloseDesktop: () => void;
  onClose: () => void;
}) {
  return (
    <CursorAnchoredMenu
      anchor={anchor}
      onClose={onClose}
      side="top"
      align="center"
    >
      <DropdownMenuSection label={label}>
        <DropdownMenuItem disabled={current} onClick={onSwitch}>
          <Icon icon={desktopIcon} />
          Switch to
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onNew}>
          <Icon icon={addIcon} />
          New desktop
        </DropdownMenuItem>
      </DropdownMenuSection>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        disabled={!closable}
        onClick={onCloseDesktop}
      >
        <Icon icon={closeIcon} />
        Close desktop
      </DropdownMenuItem>
    </CursorAnchoredMenu>
  );
}
