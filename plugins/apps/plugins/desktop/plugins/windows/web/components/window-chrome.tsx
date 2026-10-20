import {
  useCallback,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { formatShortcutLabel } from "@plugins/primitives/plugins/shortcuts/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import type { DesktopTileApp } from "@plugins/apps/plugins/desktop/plugins/shell/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  clampToBounds,
  type Desktop,
  type FloatingWindow,
  type Geometry,
  type WindowId,
} from "../hooks/use-floating-windows";
import {
  detectSnapZone,
  setSnapPreview,
  workAreaHeight,
  type SnapZone,
} from "../hooks/use-snap";
import {
  beginWindowInteraction,
  endWindowInteraction,
} from "../hooks/use-window-motion";
import { getWorkAreaReserve } from "../internal/work-area";
import { WindowResizeHandles } from "./window-resize-handles";
import {
  WindowTabStrip,
  type TabDragCommit,
  type WindowMember,
} from "./window-tab-strip";
import {
  MINIMIZE_SHORTCUT,
  TOGGLE_PIN_SHORTCUT,
  WindowSystemMenu,
  type MenuAnchor,
  type MergeTarget,
} from "./window-system-menu";
import { WindowAppTile } from "./window-app-tile";

const closeIcon = symbol("close");
const removeIcon = symbol("remove");
const cropSquareIcon = symbol("crop-square");
const filterNoneIcon = symbol("filter-none");
const fullscreenIcon = symbol("fullscreen");
const keepIcon = symbol("keep");

/** Fixed titlebar height (mockup `--title-h`, 40px); the content inset clears it. */
export const WINDOW_TITLEBAR_INSET = "2.5rem";

/**
 * The mockup's titlebar metrics (`.titlebar`, `.tb-app`, `.wc button`): window
 * chrome drawn to the mockup's pixel whatever the app's density, so the box
 * values are literals here rather than ramp steps.
 */
const TITLEBAR_STYLE = { gap: 4, paddingLeft: 6, paddingRight: 6 } as const;
const APP_BUTTON_STYLE = { width: 30, height: 28, borderRadius: 7 } as const;
const CONTROLS_STYLE = { gap: 1 } as const;
const CONTROL_STYLE = { width: 28, height: 26, borderRadius: 6 } as const;
/** Control glyph size — the mockup's 11px strokes read at this Material size. */
const CONTROL_GLYPH = { fontSize: 15 } as const;

/** Pointer travel (px) before a titlebar press becomes a window drag (mockup). */
const DRAG_THRESHOLD = 4;
/** A snapped window dragged out keeps the grab at most this far (px) below its top. */
const UNSNAP_GRAB_MAX_Y = 20;

/** Snaps whose titlebar reaches the desktop's top-right corner, under the action-bar dot. */
const TOP_RIGHT_SNAPS = new Set<SnapZone>(["maximize", "right", "top-right"]);

interface WindowChromeProps {
  /** The window this chrome paints (one titlebar per window — the active member). */
  window: FloatingWindow;
  /** The shown tab's app — the titlebar's app button. */
  appName: string;
  app: DesktopTileApp | undefined;
  focused: boolean;
  /**
   * The shown tab's app draws a sidebar: the classic titlebar (tinted, with a
   * bottom border — mockup `.has-side`). Otherwise the bar is seamless: the
   * window's own background, no border.
   */
  classic: boolean;
  setGeo: (next: (g: Geometry) => Geometry) => void;
  /** Members in tab-strip order, resolved to title + app icon for the strip. */
  members: WindowMember[];
  /** Show + focus a member (tab-strip chip click). */
  onSelectMember: (tabId: string) => void;
  /** Close one member (chip ×). */
  onCloseMember: (tabId: string) => void;
  /** Open a fresh tab as a new member of this window (the tab-strip `+`). */
  onNewTab: () => void;
  /** Close the WHOLE window (every member) — the titlebar's close control. */
  onCloseWindow: () => void;
  /** Toggle this window's always-on-top flag (re-ranks z in the geometry store). */
  onTogglePin: () => void;
  /**
   * Take the active tab full-screen: switch it to the solo placement — a single
   * tab full-app over everything — distinct from maximize, which only fills the
   * work area within the desktop.
   */
  onFullscreen: () => void;
  /** Other windows of this desktop the active tab can be merged into. */
  mergeTargets: MergeTarget[];
  /** Merge the active tab into a target window. */
  onMergeInto: (targetWindowId: WindowId) => void;
  /** Tear the active tab out into a new window (enabled when grouped). */
  onSplit: () => void;
  /** Every virtual desktop, for the "Move to desktop ▸" submenu. */
  desktops: Desktop[];
  /** The desktop this window currently lives on (checked in the menu). */
  currentDesktopId: string;
  /** Move this window to an existing desktop. */
  onMoveToDesktop: (desktopId: string) => void;
  /** Move this window to a freshly-created desktop. */
  onMoveToNewDesktop: () => void;
  /** Commit ops for a finished tab-chip drag (reorder / merge / split). */
  dragCommit: TabDragCommit;
}

/** Whether a pointer event started on a titlebar control or a tab chip (not the drag surface). */
function onControl(e: ReactPointerEvent | ReactMouseEvent): boolean {
  return (
    (e.target as Element).closest("button, [data-floating-tab-id]") !== null
  );
}

/**
 * One titlebar control (mockup `.wc button`): a glyph in a 28 × 26 hit box that
 * never starts a window drag.
 */
function TitlebarControl({
  icon,
  label,
  onClick,
  className,
}: {
  icon: IconRef;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Center
      as="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        rigidClass(),
        "text-muted-foreground hover:bg-hover-fill hover:text-foreground",
        className,
      )}
      style={CONTROL_STYLE}
    >
      <Icon icon={icon} style={CONTROL_GLYPH} />
    </Center>
  );
}

/**
 * Floating-window chrome rendered as a *sibling overlay* of the keep-alive
 * `TabSurface` (never a parent of it), so tearing a tab off / docking it never
 * remounts its content. The geometry *box* itself is applied to the stable tab
 * container by `SurfaceBody`'s `placementStyle`; this only paints the chrome on
 * top — the mockup's titlebar:
 *
 * - **the app button** — the shown tab's app tile (greyed while the window is
 *   inactive); a click opens the window menu, like a right-click on the bar;
 * - **the tab strip** — one chip per member, its `+` shown on hover;
 * - **the controls** — keep on top (accent-tinted while on), minimise,
 *   maximise / restore, full screen (solo), close; faded while inactive.
 *
 * Dragging the bar moves the window (a snapped one pops back to its free size
 * under the grab point); releasing on an armed edge snaps it, otherwise it is
 * clamped into the work area. Double-click toggles maximise.
 */
export function WindowChrome({
  window: win,
  appName,
  app,
  focused,
  classic,
  setGeo,
  members,
  onSelectMember,
  onCloseMember,
  onNewTab,
  onCloseWindow,
  onTogglePin,
  onFullscreen,
  mergeTargets,
  onMergeInto,
  onSplit,
  desktops,
  currentDesktopId,
  onMoveToDesktop,
  onMoveToNewDesktop,
  dragCommit,
}: WindowChromeProps) {
  const geo = win.geo;
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);

  // Drag the titlebar — the mockup's `startDrag`. A press only becomes a drag
  // past DRAG_THRESHOLD (so a double-click never nudges the window). A snapped
  // window pops back to its free size on the first move, keeping the grab at
  // the same fraction of its width; while dragging, the pointer's edge/corner
  // arms a snap preview; releasing over one snaps the window there, otherwise
  // the free box is clamped into the work area.
  const onTitlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || onControl(e)) return;
      e.preventDefault();
      // Titlebar → tab container → surface backdrop: the backdrop is the drag +
      // snap-detection frame. Captured at pointer-down (stable for the drag).
      const container = e.currentTarget.parentElement;
      const backdrop = container?.parentElement;
      if (!container || !backdrop) return;
      const desk = backdrop.getBoundingClientRect();
      const box = container.getBoundingClientRect();
      const workH = workAreaHeight(desk.height, getWorkAreaReserve());
      const startX = e.clientX;
      const startY = e.clientY;
      let grabX = startX - box.left;
      let grabY = startY - box.top;
      let moved = false;
      let zone: SnapZone | null = null;

      const onMove = (ev: PointerEvent) => {
        if (!moved) {
          if (
            Math.hypot(ev.clientX - startX, ev.clientY - startY) <
            DRAG_THRESHOLD
          )
            return;
          moved = true;
          // Track the cursor 1:1: no box transition while dragging.
          beginWindowInteraction(win.id);
          if (geo.snap) {
            const free = geo.restore ?? {
              x: geo.x,
              y: geo.y,
              w: geo.w,
              h: geo.h,
            };
            grabX = free.w * (grabX / box.width);
            grabY = Math.min(grabY, UNSNAP_GRAB_MAX_Y);
            setGeo((g) => ({
              ...g,
              w: free.w,
              h: free.h,
              snap: null,
              restore: undefined,
            }));
          }
        }
        const px = ev.clientX - desk.left;
        const py = ev.clientY - desk.top;
        setGeo((g) => ({ ...g, x: px - grabX, y: Math.max(0, py - grabY) }));
        zone = detectSnapZone(px, py, desk.width, workH);
        setSnapPreview(zone);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setSnapPreview(null);
        if (!moved) return;
        // End interaction first, so the final commit (below) animates: this and
        // the `setGeo` batch into one render with the transition re-enabled.
        endWindowInteraction(win.id);
        const target = zone;
        setGeo((g) =>
          target
            ? // Remember the released box so dragging back out / restore returns to it.
              {
                ...g,
                snap: target,
                restore: { x: g.x, y: g.y, w: g.w, h: g.h },
              }
            : clampToBounds(g, { width: desk.width, height: workH }),
        );
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [geo, setGeo, win.id],
  );

  // Snap to a zone, or back to the free box with `null` (mockup `setSnap`):
  // entering a snap from the free state remembers the free box as `restore`.
  const snapTo = useCallback(
    (zone: SnapZone | null) => {
      setGeo((g) =>
        zone
          ? {
              ...g,
              snap: zone,
              restore: g.restore ?? { x: g.x, y: g.y, w: g.w, h: g.h },
              minimized: false,
            }
          : g.snap
            ? { ...g, snap: null, ...(g.restore ?? {}), restore: undefined }
            : g,
      );
    },
    [setGeo],
  );
  const maximized = geo.snap === "maximize";
  const toggleMaximize = useCallback(
    () => snapTo(maximized ? null : "maximize"),
    [snapTo, maximized],
  );

  // Minimize: a flag only — the content wrapper hides (handled by the motion
  // layer) but stays mounted.
  const minimize = useCallback(() => {
    setGeo((g) => (g.minimized ? g : { ...g, minimized: true }));
  }, [setGeo]);

  const openMenuAt = useCallback(
    (x: number, y: number) => setMenuAnchor({ x, y }),
    [],
  );

  // The action-bar dot floats over the desktop's top-right corner: a window
  // reaching it insets its controls by the dot's published safe area.
  const underActionBar = geo.snap !== null && TOP_RIGHT_SNAPS.has(geo.snap);

  const controls = (
    <div
      // eslint-disable-next-line layout/no-adhoc-layout -- rigid trailing controls cluster pinned right in the titlebar's hand-rolled drag flex (see titlebar disable below)
      className={cn(rigidClass(), "flex items-center")}
      style={CONTROLS_STYLE}
    >
      <TitlebarControl
        icon={keepIcon}
        label={`Keep on top (${formatShortcutLabel(TOGGLE_PIN_SHORTCUT)})`}
        onClick={onTogglePin}
        className={
          geo.pinned
            ? "bg-primary/13 text-primary-text hover:bg-primary/13 hover:text-primary-text"
            : undefined
        }
      />
      <TitlebarControl
        icon={removeIcon}
        label={`Minimise (${formatShortcutLabel(MINIMIZE_SHORTCUT)})`}
        onClick={minimize}
        className={focused ? undefined : "opacity-45"}
      />
      <TitlebarControl
        icon={maximized ? filterNoneIcon : cropSquareIcon}
        label={maximized ? "Restore" : "Maximise"}
        onClick={toggleMaximize}
        className={focused ? undefined : "opacity-45"}
      />
      <TitlebarControl
        icon={fullscreenIcon}
        label="Full screen"
        onClick={onFullscreen}
        className={focused ? undefined : "opacity-45"}
      />
      <TitlebarControl
        icon={closeIcon}
        label="Close window"
        onClick={onCloseWindow}
        // The close control reddens on hover (the mockup's close red).
        className={cn(
          "hover:bg-destructive hover:text-destructive-foreground",
          focused ? undefined : "opacity-45",
        )}
      />
    </div>
  );

  return (
    <>
      {/* Titlebar — absolutely pinned to the top of the window box, overlaying the
          surface (which the placement insets below it). Drag surface + controls. */}
      <div
        onPointerDown={onTitlePointerDown}
        onDoubleClick={(e) => {
          if (!onControl(e)) toggleMaximize();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenuAt(e.clientX, e.clientY);
        }}
        // eslint-disable-next-line layout/no-adhoc-layout -- draggable window titlebar: top-edge-pinned, fixed height via style, hand-rolled flex row whose rigid / slack children coordinate with the move-drag region; window chrome, not a primitive row
        className={cn(
          "group/titlebar absolute inset-x-0 top-0 z-raised flex items-center",
          // Under the dot, the titlebar is the row it sits in: naming it the
          // band's anchor centres the bar on this line.
          underActionBar && "anchor-floating-bar-band",
          classic
            ? cn("border-b border-border", focused ? "bg-muted" : "bg-muted/40")
            : "bg-background",
        )}
        style={{
          ...TITLEBAR_STYLE,
          // Under the action-bar dot, its published safe area is the right inset.
          ...(underActionBar
            ? { paddingRight: "var(--floating-bar-safe-area, 6px)" }
            : null),
          height: WINDOW_TITLEBAR_INSET,
          touchAction: "none",
        }}
      >
        <Center
          as="button"
          aria-label={`${appName} — window menu`}
          title="Window menu"
          onClick={(e: ReactMouseEvent<HTMLElement>) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenuAt(r.left, r.bottom + 4);
          }}
          className={cn(rigidClass(), "hover:bg-hover-fill")}
          style={APP_BUTTON_STYLE}
        >
          <WindowAppTile app={app} size={18} radius={5} muted={!focused} />
        </Center>
        {/* In-window tab strip — one chip per member. `data-floating-window-id`
            marks the drop-zone the tab-chip drag hit-tests against. The
            flex-1 strip soaks up the slack so the chips sit left, the empty
            remainder is the move-drag region, and the controls pin right. */}
        <div
          // eslint-disable-next-line aria-safety/no-orphan-composite-role -- the role="tab" chips are rendered by WindowTabStrip (window-tab-strip.tsx)
          role="tablist"
          data-floating-window-id={win.id}
          // eslint-disable-next-line layout/no-adhoc-layout -- flexible slack region of the titlebar's hand-rolled drag flex (mockup `.tabs`: flex 1, clipped): the chips sit left and the remainder is the move-drag zone
          className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap"
          style={{ gap: 2 }}
        >
          <WindowTabStrip
            windowId={win.id}
            windowSize={{ w: geo.w, h: geo.h }}
            members={members}
            activeTabId={win.activeTabId}
            focused={focused}
            onSelect={onSelectMember}
            onCloseMember={onCloseMember}
            onNewTab={onNewTab}
            commit={dragCommit}
          />
        </div>
        {controls}
      </div>

      {/* Resize handles only on a free window — a minimised or snapped one has
          no free border to drag. */}
      {!geo.minimized && !geo.snap && (
        <WindowResizeHandles setGeo={setGeo} windowId={win.id} />
      )}

      <WindowSystemMenu
        anchor={menuAnchor}
        onClose={() => setMenuAnchor(null)}
        geo={geo}
        onSnap={snapTo}
        onMinimize={minimize}
        onMaximize={toggleMaximize}
        onFullscreen={onFullscreen}
        onTogglePin={onTogglePin}
        onCloseWindow={onCloseWindow}
        mergeTargets={mergeTargets}
        onMergeInto={onMergeInto}
        canSplit={win.members.length > 1}
        onSplit={onSplit}
        desktops={desktops}
        currentDesktopId={currentDesktopId}
        onMoveToDesktop={onMoveToDesktop}
        onMoveToNewDesktop={onMoveToNewDesktop}
      />
    </>
  );
}
