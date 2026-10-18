import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useTabs } from "@plugins/apps-core/plugins/tabs/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import type { CursorAnchor } from "@plugins/primitives/plugins/overlay/plugins/cursor-menu/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { toggleLauncher } from "@plugins/apps/plugins/desktop/plugins/launcher/web";
import {
  createDesktop,
  getDesktopsState,
  getFloatingWindow,
  removeDesktop,
  setActiveDesktop,
  setMinimizeTargetResolver,
  setPeekedWindow,
  setWorkAreaReserve,
  toggleOverview,
  toggleShowDesktop,
  topmostWindowOnDesktop,
  useDesktops,
  useOverviewActive,
  type FloatingWindow,
} from "@plugins/apps/plugins/desktop/plugins/windows/web";
import { entryClick } from "../internal/shelf-model";
import {
  useShelfActions,
  useShelfModel,
  type ShelfAppEntry,
} from "../internal/use-shelf-model";
import { ShelfEntryButton } from "./shelf-entry";
import { ShelfPopover } from "./shelf-popover";
import { PeekThumbs } from "./peek-thumbs";
import { Pager, visibleWindowsOf } from "./pager";
import { DesktopPreview } from "./desktop-preview";
import { AppMenu, DesktopMenu, menuAnchorAbove } from "./shelf-menus";
import { TrayClock } from "./tray-clock";

const appsIcon = symbol("apps");

/** The gap the work area keeps above the dock (mockup `work()`: dock + 16). */
const DOCK_RESERVE_GAP = 16;
/** How long the peek lingers after the pointer leaves (mockup `hidePeek`). */
const PEEK_HIDE_MS = 140;
/** How far above its anchor each popover floats (mockup `showPeek` / `showDeskPreview`). */
const APP_PEEK_GAP = 16;
const DESKTOP_PEEK_GAP = 20;

/** What the hover popover shows, and the element it floats over. */
type Peek =
  | { kind: "app"; appId: string; anchor: HTMLElement }
  | { kind: "desktop"; desktopId: string; anchor: HTMLElement };

/** The open right-click menu. */
type Menu =
  | { kind: "app"; appId: string; anchor: CursorAnchor }
  | { kind: "desktop"; desktopId: string; anchor: CursorAnchor };

/**
 * The desktop's bottom shelf (mockup `#shelf`, `dock` variant): a frosted
 * dock centred 8px above the desktop's bottom edge holding, left to right, the
 * launcher button, the pinned apps, the running apps that are not pinned, and
 * the tray — the pager's mini-desktops, the overview button and the clock.
 *
 * It owns everything that floats off the dock: the peek (window thumbnails
 * over an app, a desktop preview over a mini), the app and desktop menus. And
 * it tells the windows where it is: the work area keeps the dock's height plus
 * 16px free (so a maximised window never slides under it), and a window
 * minimises into its app's entry.
 */
export function Shelf({ tabIds }: { tabIds: string[] }) {
  const model = useShelfModel(tabIds);
  const actions = useShelfActions();
  const { tabs, focusTab } = useTabs();
  const { desktops, activeDesktopId } = useDesktops();
  const overview = useOverviewActive();

  const [layerEl, setLayerEl] = useState<HTMLElement | null>(null);
  const [layerRef, { width: deskW, height: deskH }] = useElementSize();
  const [dockRef, { height: dockH }] = useElementSize<HTMLDivElement>();
  const setLayer = useCallback(
    (el: HTMLElement | null) => {
      layerRef(el);
      setLayerEl(el);
    },
    [layerRef],
  );

  // The work area: the dock's height plus the gap stays free at the bottom.
  useEffect(
    () =>
      setWorkAreaReserve(dockH > 0 ? Math.ceil(dockH) + DOCK_RESERVE_GAP : 0),
    [dockH],
  );

  // Each app entry's element, so a minimising window aims at its app's entry.
  const entryEls = useRef(new Map<string, HTMLElement>());
  const latestTabs = useLatestRef(tabs);
  useEffect(
    () =>
      setMinimizeTargetResolver((windowId) => {
        const w = getFloatingWindow(windowId);
        const appId = w
          ? latestTabs.current.find((t) => t.tabId === w.activeTabId)?.appId
          : undefined;
        const el =
          appId === undefined ? undefined : entryEls.current.get(appId);
        return el?.getBoundingClientRect() ?? null;
      }),
    [latestTabs],
  );

  // ── Peek ──
  const [peek, setPeek] = useState<Peek | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const cancelHide = () => clearTimeout(hideTimer.current);
  const hidePeek = (delayed: boolean) => {
    cancelHide();
    const go = () => {
      setPeek(null);
      setPeekedWindow(null);
    };
    if (delayed) hideTimer.current = setTimeout(go, PEEK_HIDE_MS);
    else go();
  };
  const showPeek = (next: Peek) => {
    cancelHide();
    if (menu || overview) return;
    if (peek && hoverKey(peek) === hoverKey(next)) return;
    setPeekedWindow(null);
    setPeek(next);
  };
  // Leaving the desktop drops the timer and any window still highlighted.
  useEffect(
    () => () => {
      clearTimeout(hideTimer.current);
      setPeekedWindow(null);
    },
    [],
  );

  // ── Desktops ──
  const switchDesktop = (id: string) => {
    hidePeek(false);
    setActiveDesktop(id);
    const top = topmostWindowOnDesktop(id);
    if (top) focusTab(top.activeTabId);
  };
  // The current desktop's mini toggles show desktop; another one switches to it.
  const pickDesktop = (id: string) => {
    if (id !== activeDesktopId) return switchDesktop(id);
    hidePeek(false);
    toggleShowDesktop();
  };
  const newDesktop = () => switchDesktop(createDesktop());
  const closeDesktop = (id: string) => {
    hidePeek(false);
    const wasActive = id === activeDesktopId;
    removeDesktop(id);
    if (!wasActive) return;
    // The store moved us to a neighbour: focus what is in front there.
    const top = topmostWindowOnDesktop(getDesktopsState().activeDesktopId);
    if (top) focusTab(top.activeTabId);
  };
  const desktopLabel = (id: string) =>
    `Desktop ${desktops.findIndex((d) => d.id === id) + 1}`;

  // ── Entries ──
  const windowsOf = (entry: ShelfAppEntry): FloatingWindow[] =>
    entry.windows.flatMap((w) => model.windows.get(w.id) ?? []);
  const onEntryClick = (entry: ShelfAppEntry, e: MouseEvent) => {
    hidePeek(false);
    if (e.shiftKey || e.altKey) return actions.openWindow(entry.appId);
    const action = entryClick(entry.windows, model.focusedWindowId);
    if (action.kind === "open") actions.openWindow(entry.appId);
    else actions.runWindowAction(action);
  };

  const menuEntry =
    menu?.kind === "app"
      ? model.entries.find((e) => e.appId === menu.appId)
      : undefined;
  const peekEntry =
    peek?.kind === "app"
      ? model.entries.find((e) => e.appId === peek.appId)
      : undefined;

  return (
    <Layer
      ref={setLayer}
      layer="overlay"
      decorative
      className="text-foreground"
    >
      <Pin
        to="bottom"
        offset="sm"
        layer="base"
        // `w-max`: a box pinned at `left: 50%` would otherwise shrink-wrap to
        // the half of the desktop right of its anchor.
        className="pointer-events-auto w-max max-w-[calc(100%-16px)]"
      >
        <div
          ref={dockRef}
          // eslint-disable-next-line layout/no-adhoc-layout, spacing/no-adhoc-spacing -- the mockup's `.sh-dock` row: gap 4px, padding 6px (off the ramp)
          className={cn(
            "flex max-w-full items-center gap-xs p-[6px] rounded-3xl",
            "whitespace-nowrap max-[760px]:overflow-hidden",
            // The overview slides the dock below the desktop's edge and fades
            // it (mockup `#root.is-overview .sh-dock`).
            "transition-[transform,opacity] duration-[250ms] ease-in-out",
            overview && "pointer-events-none translate-y-[130%] opacity-0",
            // The mockup's frosted dock glass (`--dock-bg`, blur 30 saturate
            // 1.8) and its hairline / top highlight / drop; no token spells it.
            "bg-background/55 backdrop-blur-[30px] backdrop-saturate-[1.8]",
            "shadow-[0_0_0_0.5px_rgba(0,0,0,0.12),inset_0_0.5px_0_rgba(255,255,255,0.4),0_10px_30px_-8px_rgba(0,0,0,0.3)]",
          )}
        >
          <button
            type="button"
            title="Apps (⌘K)"
            aria-label="Apps"
            onClick={() => {
              hidePeek(false);
              toggleLauncher();
            }}
            className={cn(
              rigidClass(),
              "size-11.5 rounded-xl bg-foreground/10 max-[760px]:size-9.5",
              "transition-transform duration-[180ms] ease-[cubic-bezier(.2,.8,.2,1)] hover:-translate-y-[3px]",
            )}
          >
            <Center className="size-full">
              <Icon icon={appsIcon} className="size-5" />
            </Center>
          </button>
          <Separator />
          <div
            // eslint-disable-next-line layout/no-adhoc-layout -- the mockup's `.sh-apps` row; it yields so a crowded dock clips instead of overflowing the desktop
            className="flex min-w-0 items-center gap-xs"
            onPointerLeave={() => hidePeek(true)}
          >
            {model.entries.map((entry, i) => (
              <Fragment key={entry.appId}>
                {i > 0 && model.entries[i - 1]!.section !== entry.section && (
                  <Separator />
                )}
                <ShelfEntryButton
                  entry={entry}
                  active={entry.windows.some(
                    (w) => w.id === model.focusedWindowId,
                  )}
                  ref={(el) => {
                    if (el) entryEls.current.set(entry.appId, el);
                    else entryEls.current.delete(entry.appId);
                  }}
                  onClick={(e) => onEntryClick(entry, e)}
                  onAuxClick={(e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    hidePeek(false);
                    actions.openWindow(entry.appId);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    hidePeek(false);
                    setMenu({
                      kind: "app",
                      appId: entry.appId,
                      anchor: menuAnchorAbove(e.currentTarget),
                    });
                  }}
                  onPointerOver={(e) =>
                    showPeek({
                      kind: "app",
                      appId: entry.appId,
                      anchor: e.currentTarget,
                    })
                  }
                />
              </Fragment>
            ))}
          </div>
          <Separator />
          {/* eslint-disable-next-line layout/no-adhoc-layout, spacing/no-adhoc-spacing -- the mockup's `.sh-tray` row (gap 6px, off the ramp) */}
          <div className={cn(rigidClass(), "flex items-center gap-[6px]")}>
            <div
              className="max-[760px]:hidden"
              onPointerLeave={() => hidePeek(true)}
            >
              <Pager
                desktops={desktops}
                activeDesktopId={activeDesktopId}
                windows={model.windows}
                focusedWindowId={model.focusedWindowId}
                desktopW={deskW}
                desktopH={deskH}
                onPick={pickDesktop}
                onCreate={newDesktop}
                onRemove={closeDesktop}
                onOverview={() => {
                  hidePeek(false);
                  toggleOverview();
                }}
                onPeekDesktop={(desktopId, anchor) =>
                  showPeek({ kind: "desktop", desktopId, anchor })
                }
                onDesktopMenu={(desktopId, el) => {
                  hidePeek(false);
                  setMenu({
                    kind: "desktop",
                    desktopId,
                    anchor: menuAnchorAbove(el),
                  });
                }}
              />
            </div>
            <TrayClock />
          </div>
        </div>
      </Pin>

      {peek && layerEl && (
        <ShelfPopover
          key={hoverKey(peek)}
          anchor={peek.anchor}
          layer={layerEl}
          gap={peek.kind === "app" ? APP_PEEK_GAP : DESKTOP_PEEK_GAP}
          onPointerEnter={cancelHide}
          onPointerLeave={() => hidePeek(true)}
          // eslint-disable-next-line spacing/no-adhoc-spacing -- the mockup's peek paddings: the name tip 5px 10px, the thumbnails 6px (off the ramp)
          className={
            peek.kind === "app" && peekEntry && peekEntry.windows.length === 0
              ? // The app-name tip (mockup `.peek-pop.tip`).
                "rounded-lg px-[10px] py-[5px] text-caption font-[550]"
              : peek.kind === "app"
                ? "rounded-2xl p-[6px]"
                : "rounded-2xl p-sm"
          }
        >
          {peek.kind === "app" ? (
            peekEntry === undefined ? null : peekEntry.windows.length === 0 ? (
              peekEntry.app.app.name
            ) : (
              <PeekThumbs
                app={peekEntry.app}
                windows={windowsOf(peekEntry)}
                focusedWindowId={model.focusedWindowId}
                titleOf={model.titleOf}
                onPick={(w) => {
                  hidePeek(false);
                  actions.runWindowAction(
                    w.geo.minimized
                      ? { kind: "restore", windowId: w.id }
                      : { kind: "focus", windowId: w.id },
                  );
                }}
                onClose={(w) => actions.closeWindow(w.id)}
                onNewWindow={() => {
                  hidePeek(false);
                  actions.openWindow(peekEntry.appId);
                }}
              />
            )
          ) : (
            <DesktopPreview
              label={desktopLabel(peek.desktopId)}
              current={peek.desktopId === activeDesktopId}
              windows={visibleWindowsOf(model.windows.values(), peek.desktopId)}
              desktopW={deskW}
              desktopH={deskH}
            />
          )}
        </ShelfPopover>
      )}

      <AppMenu
        anchor={menu?.kind === "app" ? menu.anchor : null}
        entry={menuEntry}
        windows={menuEntry ? windowsOf(menuEntry) : []}
        focusedWindowId={model.focusedWindowId}
        titleOf={model.titleOf}
        actions={actions}
        onClose={() => setMenu(null)}
      />
      <DesktopMenu
        anchor={menu?.kind === "desktop" ? menu.anchor : null}
        label={menu?.kind === "desktop" ? desktopLabel(menu.desktopId) : ""}
        current={menu?.kind === "desktop" && menu.desktopId === activeDesktopId}
        closable={desktops.length > 1}
        onSwitch={() => {
          if (menu?.kind === "desktop") switchDesktop(menu.desktopId);
        }}
        onNew={newDesktop}
        onCloseDesktop={() => {
          if (menu?.kind === "desktop") closeDesktop(menu.desktopId);
        }}
        onClose={() => setMenu(null)}
      />
    </Layer>
  );
}

/** The peek's identity: a new key rebuilds it (fresh snapshots). */
function hoverKey(p: Peek): string {
  return p.kind === "app" ? `app:${p.appId}` : `desktop:${p.desktopId}`;
}

/** A hairline between the dock's groups (mockup `.sh-sep`: 1×30, 4px margins). */
function Separator() {
  return (
    <span aria-hidden className={cn(rigidClass(), "block px-xs")}>
      <span className="block h-[30px] w-px bg-input" />
    </span>
  );
}
