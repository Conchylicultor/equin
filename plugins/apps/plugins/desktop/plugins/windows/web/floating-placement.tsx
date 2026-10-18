import { DESKTOP_PLACEMENT_ID } from "@plugins/apps/plugins/desktop/plugins/shell/core";
import { useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { Apps } from "@plugins/apps-core/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useTabs } from "@plugins/apps-core/plugins/tabs/web";
import {
  usePlacementStyle,
  type PlacementChromeProps,
  type PlacementDef,
} from "@plugins/apps-core/plugins/surface/web";
import { useSidebarDrawnOn } from "@plugins/primitives/plugins/app-shell/web";
import {
  clampToBounds,
  createDesktop,
  mergeTabIntoWindow,
  moveWindowToDesktop,
  placeWindows,
  reorderMember,
  setActiveMember,
  splitTabToNewWindow,
  toggleWindowPin,
  useDesktops,
  useFloatingWindows,
  useTabWindow,
  type Geometry,
} from "./hooks/use-floating-windows";
import { workAreaHeight } from "./hooks/use-snap";
import { peekDeskBounds } from "./internal/desk-bounds";
import { getWorkAreaReserve } from "./internal/work-area";
import {
  WindowChrome,
  WINDOW_TITLEBAR_INSET,
} from "./components/window-chrome";
import {
  type TabDragCommit,
  type WindowMember,
} from "./components/window-tab-strip";
import { type MergeTarget } from "./components/window-system-menu";
import { DesktopBackdrop } from "./components/desktop-backdrop";
import { FloatingForeground } from "./components/floating-foreground";
import { CLOSE_MS, useFloatingWindowStyle } from "./hooks/use-window-motion";
import { symbol } from "@plugins/ui/plugins/icons/core";

const webAssetIcon = symbol("web-asset");

/**
 * The floating placement: a free-floating, draggable/resizable window over the
 * desktop wallpaper backdrop. Its geometry box lives entirely in this plugin (the
 * window store) and is pushed onto the shared host container via the keep-alive
 * style channel — so the generic surface body never knows about windows.
 */
export const floatingDef: PlacementDef = {
  id: DESKTOP_PLACEMENT_ID,
  label: "Desktop",
  icon: webAssetIcon,
  order: 1,
  visibleWhenUnfocused: true,
  newTabFollows: true,
  // The desktop draws its own frame — its shelf replaces the tab bar and rail.
  ownsChrome: true,
  // Defer teardown of a just-closed floating tab by the close tween's duration so
  // `FloatingChrome` can animate the window out before the host unmounts it.
  // Single-sourced with the tween (CLOSE_MS) so retention + tween never drift.
  exitDurationMs: CLOSE_MS,
  // A free box inside the surface — the `window` frame. Its position and size are
  // pushed per-window by `FloatingChrome`; the frame owns the positioning context
  // and the clip to its own corner, so this only names the extra chrome that
  // makes the box read as a WINDOW: the mockup's inner hairline (`outline 0.5px`,
  // drawn inside the box so it never adds to it). Its canvas is not here — the
  // host container is a `<Theme surface="canvas">`, so the window is filled with
  // the app's own background whether or not this mode says so. Corner and
  // shadow are NOT static here: the motion layer drives them per window (square
  // when maximised; focused lifts, unfocused recedes).
  frame: "window",
  frameClassName: cn(
    "outline-[0.5px] outline-offset-[-0.5px] outline-border outline-solid",
  ),
  Backdrop: DesktopBackdrop,
  Foreground: FloatingForeground,
  Chrome: FloatingChrome,
};

/**
 * Floating window chrome — one instance per floating *tab*. It resolves the
 * {@link FloatingWindow} holding this tab via {@link useTabWindow} and pushes the
 * window's derived box + titlebar inset onto the host-owned stable container
 * through {@link usePlacementStyle}, clearing them on unmount so a dock / solo
 * transition falls back to the host's static defaults (keep-alive).
 *
 * A window can hold several member tabs (browser-style grouping); only the
 * ACTIVE member paints the visible box and renders the `WindowChrome` titlebar.
 * Inactive members push `display:none` so they stay mounted but hidden — there is
 * exactly one titlebar per window. Geometry, snap, pin, minimize all operate on
 * the window (shared by every member). Merge / split are pure store mutations
 * driven from the titlebar's system menu (Phase 1).
 *
 * Focus-on-pointerdown is owned by the host; this only ADDS raise-to-front via
 * the registered pointer-down-capture handler.
 */
function FloatingChrome({
  tabId,
  appId,
  focused,
  exiting,
}: PlacementChromeProps) {
  const { window: win, isActive, setGeo, bringToFront } = useTabWindow(tabId);
  const windows = useFloatingWindows();
  const { desktops, activeDesktopId } = useDesktops();
  const { tabs, titles, focusTab, closeTab, openTab, setMode } = useTabs();
  const apps = Apps.App.useContributions();
  const {
    setContainerStyle,
    setContentInsetStyle,
    setContainerPointerDownCapture,
  } = usePlacementStyle();

  // Store reconcile (pruneWindows) lives in the floating Foreground now, keyed on
  // the host's live + retained id sets — so a window mid-exit-tween isn't pruned
  // out from under this chrome (which would re-mint a fresh window + play an
  // intro). This chrome only animates; it never touches the windows map's lifecycle.

  // When this tab becomes globally focused but isn't its window's active member
  // (focus arrived from cycle / dock / a fresh tab), make it the shown member so
  // the window's model stays consistent with the host focus.
  useEffect(() => {
    if (focused && !isActive) setActiveMember(win.id, tabId);
  }, [focused, isActive, win.id, tabId]);

  // The animated window box → the stable container. The motion layer derives the
  // box (snap / maximize / free) plus the open / minimize / restore tweens and a
  // box `transition` (suppressed mid-drag). Inactive members and minimized windows
  // resolve to `hidden` (display:none) but stay mounted (keep-alive) — the dock
  // chip is then the only restore target. The visible member clears the titlebar
  // via the content inset.
  // This (whole-)window is closing only when this tab is exiting AND none of its
  // window's members are still live in the store — i.e. the entire window is going
  // away (titlebar X / last member / mod+w on a single-member window), not just a
  // single chip of a multi-tab window (which the Foreground's prune resolves to an
  // instant sibling reveal). Only a whole-window close plays the exit tween.
  const liveIds = useMemo(() => new Set(tabs.map((t) => t.tabId)), [tabs]);
  const windowClosing = exiting && win.members.every((m) => !liveIds.has(m));

  // Virtual-desktop visibility: a window off the active desktop is hidden
  // (display:none, kept mounted) so a desktop switch is instant with no remount.
  const onActiveDesktop = win.desktopId === activeDesktopId;

  const { containerStyle, hidden } = useFloatingWindowStyle(
    win,
    tabId,
    isActive,
    windowClosing,
    focused,
    onActiveDesktop,
  );
  const insetStyle = useMemo(
    () => (hidden ? { display: "none" } : { top: WINDOW_TITLEBAR_INSET }),
    [hidden],
  );
  useLayoutEffect(() => {
    setContainerStyle(containerStyle);
    setContentInsetStyle(insetStyle);
    return () => {
      // Cleanup: clear the pushed style so docked / solo fall back to defaults.
      setContainerStyle(null);
      setContentInsetStyle(null);
    };
  }, [containerStyle, insetStyle, setContainerStyle, setContentInsetStyle]);

  // Raise this window above others on any pointer-down inside it. The host wires
  // its own focus first; we only add the z-bump.
  useLayoutEffect(() => {
    setContainerPointerDownCapture(() => bringToFront());
    return () => setContainerPointerDownCapture(null);
  }, [setContainerPointerDownCapture, bringToFront]);

  const togglePin = useCallback(() => toggleWindowPin(win.id), [win.id]);

  // Take this window's active tab full-screen: focus it (so it's the tab solo
  // mode shows) and switch the whole surface into solo mode — the windows vanish
  // (windows mode is no longer active), so nothing can overlap. The solo overlay's
  // exit button / Esc returns to windows mode (the mode we came from).
  const onFullscreen = useCallback(() => {
    focusTab(win.activeTabId);
    setMode("solo");
  }, [focusTab, setMode, win.activeTabId]);

  // Inactive members render no chrome (one titlebar per window). Their container
  // is display:none anyway, so they paint nothing.
  // Resolve the strip's member rows (title + app icon) and the merge targets
  // (every OTHER window, labelled by its active member). Done ONLY for the active
  // member, since only it renders the titlebar.
  const tabAppId = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tabs) m.set(t.tabId, t.appId);
    return m;
  }, [tabs]);

  const memberRows = useMemo<WindowMember[]>(
    () =>
      win.members.map((memberId) => {
        const appId = tabAppId.get(memberId);
        const entry = apps.find((a) => a.id === appId);
        return {
          tabId: memberId,
          title: titles[memberId] ?? entry?.app.name ?? "Window",
          icon: entry?.icon,
        };
      }),
    [win.members, tabAppId, apps, titles],
  );

  // The window is "of" the app of its shown tab — the titlebar's app button.
  const shownApp = apps.find((a) => a.id === appId);

  // Merge targets: the other windows of this window's desktop, each labelled
  // "App — title" by its shown tab (mockup `windowMenu`).
  const mergeTargets = useMemo<MergeTarget[]>(() => {
    const out: MergeTarget[] = [];
    for (const other of windows.values()) {
      if (other.id === win.id || other.desktopId !== win.desktopId) continue;
      const otherApp = apps.find(
        (a) => a.id === tabAppId.get(other.activeTabId),
      );
      out.push({
        id: other.id,
        appName: otherApp?.app.name ?? "Window",
        appIcon: otherApp?.icon,
        title: titles[other.activeTabId] ?? otherApp?.app.name ?? "Window",
      });
    }
    return out;
  }, [windows, win.id, win.desktopId, tabAppId, apps, titles]);

  // Seamless vs classic titlebar is derived, never configured: classic exactly
  // when the shown tab's app shell draws a sidebar (mockup `.has-side`).
  const classic = useSidebarDrawnOn(tabId);

  const onSelectMember = useCallback(
    (memberId: string) => {
      setActiveMember(win.id, memberId);
      focusTab(memberId);
    },
    [win.id, focusTab],
  );

  // The tab-strip `+`: open a fresh Home tab (matching the docked tab bar's `+`)
  // and immediately merge it into THIS window so it joins as a new member rather
  // than minting its own singleton window. `openTab` only mutates the apps store;
  // the merge runs synchronously before the new tab's chrome mounts, so its
  // `readWindowForTab` resolves to this window instead of auto-creating one.
  const onNewTab = useCallback(() => {
    const newTabId = openTab("home");
    mergeTabIntoWindow(newTabId, win.id);
  }, [openTab, win.id]);

  const onCloseWindow = useCallback(() => {
    // Close every member; pruneWindows then deletes the now-empty window.
    for (const memberId of win.members) closeTab(memberId);
  }, [win.members, closeTab]);

  const onMergeInto = useCallback(
    (targetWindowId: string) =>
      mergeTabIntoWindow(win.activeTabId, targetWindowId),
    [win.activeTabId],
  );

  const onSplit = useCallback(
    () => splitTabToNewWindow(win.activeTabId),
    [win.activeTabId],
  );

  // Move-to-desktop (system-menu submenu). Moving via the menu deliberately does
  // NOT switch the active desktop (macOS "move to desktop" behaviour): the window
  // simply leaves the current desktop and disappears; the user stays put. "New
  // desktop" mints one and moves the window there, again without following.
  const onMoveToDesktop = useCallback(
    (desktopId: string) => moveWindowToDesktop(win.id, desktopId),
    [win.id],
  );

  const onMoveToNewDesktop = useCallback(() => {
    const id = createDesktop();
    moveWindowToDesktop(win.id, id);
  }, [win.id]);

  // Commit ops for a finished tab-chip drag. reorder/merge mutate the strip;
  // split tears off at the drop point. Each ends by focusing the moved tab so it
  // is shown + focused in its new home (merge/split already set it active in the
  // store; focusTab brings the host focus along so the titlebar reads focused).
  const dragCommit = useMemo<TabDragCommit>(
    () => ({
      reorder: (tabId, index) => {
        reorderMember(win.id, tabId, index);
      },
      merge: (tabId, targetWindowId, index) => {
        mergeTabIntoWindow(tabId, targetWindowId, index);
        focusTab(tabId);
      },
      split: (tabId, box) => {
        const placed = clampToWorkArea(box);
        // A lone tab dragged out just moves its window (mockup).
        if (win.members.length === 1) placeWindows(new Map([[win.id, placed]]));
        else splitTabToNewWindow(tabId, placed);
        focusTab(tabId);
      },
    }),
    [win.id, win.members.length, focusTab],
  );

  if (!isActive) return null;

  return (
    <WindowChrome
      window={win}
      appName={shownApp?.app.name ?? "Window"}
      appIcon={shownApp?.icon}
      focused={focused}
      classic={classic}
      setGeo={setGeo}
      members={memberRows}
      onSelectMember={onSelectMember}
      onCloseMember={closeTab}
      onNewTab={onNewTab}
      onCloseWindow={onCloseWindow}
      onTogglePin={togglePin}
      onFullscreen={onFullscreen}
      mergeTargets={mergeTargets}
      onMergeInto={onMergeInto}
      onSplit={onSplit}
      desktops={desktops}
      currentDesktopId={win.desktopId}
      onMoveToDesktop={onMoveToDesktop}
      onMoveToNewDesktop={onMoveToNewDesktop}
      dragCommit={dragCommit}
    />
  );
}

/**
 * A tear-off box pulled into the work area (mockup `clamp`), so a tab dropped
 * at the desktop's edge opens a window that can still be grabbed.
 */
function clampToWorkArea(box: { x: number; y: number; w: number; h: number }): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const bounds = peekDeskBounds();
  if (!bounds) return box;
  const probe = { ...box, z: 0, pinned: false, minimized: false, snap: null };
  const clamped: Geometry = clampToBounds(probe, {
    width: bounds.width,
    height: workAreaHeight(bounds.height, getWorkAreaReserve()),
  });
  return { x: clamped.x, y: clamped.y, w: clamped.w, h: clamped.h };
}
