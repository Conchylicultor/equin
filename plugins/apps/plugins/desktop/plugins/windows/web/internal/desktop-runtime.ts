import { useSyncExternalStore } from "react";
import {
  defineInstallSink,
  type InstallSink,
} from "@plugins/primitives/plugins/scope/plugins/install-sink/web";
import {
  peekFocusedTabSet,
  useTabs,
} from "@plugins/apps-core/plugins/tabs/web";
import {
  createWindowStore,
  type Bounds,
  type WindowId,
  type WindowStore,
} from "./window-store";
import type { OverviewSlot } from "./overview-layout";

/**
 * What the windows need of the tab set they draw — its live tab order and the
 * focus / close / open actions — for commands running outside React (a
 * shortcut). Installed by the floating Foreground's tabs bridge.
 */
export interface DesktopTabs {
  tabIds: string[];
  focusTab(tabId: string): void;
  closeTab(tabId: string): void;
  openTab(appId: string): string;
  appIdOf(tabId: string): string | undefined;
}

/** A value the desktop's subtrees share: written in one, read in another. */
function createSignal<T>(initial: T) {
  let value = initial;
  const subscribers = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(value, next)) return;
      value = next;
      for (const fn of subscribers) fn();
    },
    subscribe(cb: () => void) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };
}

/**
 * ONE desktop's state — the desktop drawn in one tab set (`TabsApi.id`): the
 * page's own, or an `AppEmbed`'s. Its windows and virtual desktops, and the
 * channels its subtrees share (writer and reader in unrelated subtrees, e.g.
 * the shelf and the windows): the work-area reserve the shelf keeps, the
 * backdrop's size, where a window minimises to, the peeked window, the open
 * overview, and the tab set's actions for commands. Two desktops on one page
 * (an embedded demo beside the app's own) therefore never share a window, a
 * z-order, a reserve or a stored layout.
 */
export function createDesktopRuntime(tabSetId: string, persisted: boolean) {
  const reserve = createSignal(0);
  const peeked = createSignal<WindowId | null>(null);
  const overview = createSignal<ReadonlyMap<WindowId, OverviewSlot> | null>(
    null,
  );
  // The windows under an active pointer drag / resize (their box transition
  // is suppressed meanwhile). Per desktop: window ids restart at `w1` in each.
  const interacting = createSignal<ReadonlySet<WindowId>>(new Set());
  const deskBounds = defineInstallSink<() => Bounds | null>({
    name: `desktop.desk-bounds:${tabSetId}`,
    what: "the desktop backdrop's size reader (installed by the windows' Foreground)",
  });
  const minimizeTarget = defineInstallSink<
    (windowId: WindowId) => DOMRect | null
  >({
    name: `desktop.minimize-target:${tabSetId}`,
    what: "the shelf's minimise-target resolver (installed by apps/desktop/shelf)",
  });
  const tabs = defineInstallSink<DesktopTabs>({
    name: `desktop.tabs:${tabSetId}`,
    what: "the floating tab set's bridge (installed by the floating Foreground)",
  });
  return {
    tabSetId,
    windows: createWindowStore({ persisted }),
    /**
     * Reserve `px` at the bottom of the work area (the shelf's dock). Returns
     * a disposer that clears it, if it is still the value set.
     */
    setWorkAreaReserve(px: number): () => void {
      reserve.set(px);
      return () => {
        if (reserve.get() === px) reserve.set(0);
      };
    },
    getWorkAreaReserve: reserve.get,
    reserve,
    /** Install the backdrop's size reader; the disposer restores the previous one. */
    setDeskBoundsReader: (next: () => Bounds | null) =>
      deskBounds.install(next),
    /** The backdrop's size, or null before it measured. Not from render. */
    deskBounds: (): Bounds | null => deskBounds.peek()?.() ?? null,
    /** Install where a window minimises to (the shelf's entry). */
    setMinimizeTargetResolver: (next: (windowId: WindowId) => DOMRect | null) =>
      minimizeTarget.install(next),
    /** Where `windowId` minimises to, or null (a straight drop). Not from render. */
    minimizeTargetOf: (windowId: WindowId): DOMRect | null =>
      minimizeTarget.peek()?.(windowId) ?? null,
    /** Raise one window over all and fade the rest (the shelf's thumbnails); null ends it. */
    setPeekedWindow: (id: WindowId | null) => peeked.set(id),
    peeked,
    /** Open the overview with these slots (no-op for none). */
    showOverview(next: readonly OverviewSlot[]): void {
      if (next.length === 0) return;
      overview.set(new Map(next.map((s) => [s.id, s])));
    },
    hideOverview: () => overview.set(null),
    isOverviewOpen: () => overview.get() !== null,
    overview,
    /** Mark a window as under active pointer manipulation (drag / resize start). */
    beginInteraction(id: WindowId): void {
      if (interacting.get().has(id)) return;
      interacting.set(new Set([...interacting.get(), id]));
    },
    /** Clear a window's active-manipulation flag (drag / resize end). */
    endInteraction(id: WindowId): void {
      if (!interacting.get().has(id)) return;
      const next = new Set(interacting.get());
      next.delete(id);
      interacting.set(next);
    },
    interacting,
    /** Install the tab set's bridge; the disposer restores the previous one. */
    installTabs: (bridge: DesktopTabs) => tabs.install(bridge),
    /** The tab set's bridge, or null before the Foreground mounted. Not from render. */
    tabs: (): DesktopTabs | null => tabs.peek(),
  };
}

/** One tab set's desktop — see {@link createDesktopRuntime}. */
export type DesktopRuntime = ReturnType<typeof createDesktopRuntime>;

/**
 * The desktops, one per tab set that ever drew one — keyed by tab-set id. The
 * page's is persisted (its windows come back on reload); an embedded one is not.
 * An embedded entry outlives its embed (an id is never reused, so it is never
 * read again).
 */
const runtimes = new Map<string, DesktopRuntime>();

function desktopFor(tabSetId: string, persisted: boolean): DesktopRuntime {
  let runtime = runtimes.get(tabSetId);
  if (runtime === undefined) {
    runtime = createDesktopRuntime(tabSetId, persisted);
    runtimes.set(tabSetId, runtime);
  }
  return runtime;
}

/** The desktop of the tab set this component renders in. */
export function useDesktop(): DesktopRuntime {
  const { id, contained } = useTabs();
  return desktopFor(id, !contained);
}

/**
 * The desktop of the tab set the user is in, for code outside React (a
 * shortcut's handler, a command) — `peekFocusedTabSet()`'s. Undefined before any
 * tab set mounted.
 */
export function peekFocusedDesktop(): DesktopRuntime | undefined {
  const set = peekFocusedTabSet();
  return set === undefined ? undefined : desktopFor(set.id, !set.contained);
}

/** The bottom strip the shelf keeps, reactively. */
export function useWorkAreaReserve(): number {
  const { reserve } = useDesktop();
  return useSyncExternalStore(reserve.subscribe, reserve.get, reserve.get);
}

/** The window being peeked at (the shelf's thumbnails), reactively. */
export function usePeekedWindow(): WindowId | null {
  const { peeked } = useDesktop();
  return useSyncExternalStore(peeked.subscribe, peeked.get, peeked.get);
}

/** The open overview's slots, or null when it is closed. */
export function useOverviewSlots(): ReadonlyMap<WindowId, OverviewSlot> | null {
  const { overview } = useDesktop();
  return useSyncExternalStore(overview.subscribe, overview.get, overview.get);
}

/** Whether `id` is being pointer-dragged or resized right now. */
export function useWindowInteracting(id: WindowId): boolean {
  const { interacting } = useDesktop();
  const isOn = () => interacting.get().has(id);
  return useSyncExternalStore(interacting.subscribe, isOn, () => false);
}

/** Whether the overview is open. */
export function useOverviewActive(): boolean {
  const { overview } = useDesktop();
  const isOpen = () => overview.get() !== null;
  return useSyncExternalStore(overview.subscribe, isOpen, () => false);
}

export type { WindowStore };

/**
 * A slot ONE desktop's overlay fills and that desktop's callers use — the
 * per-desktop form of an install sink, for a `Desktop.Overlay` plugin's own
 * controls (the launcher's open / close, the switcher's step): the overlay
 * mounted on a desktop installs into that desktop's slot, and the shelf button
 * or a shortcut reaches the one of the desktop it acts on. Two desktops on a
 * page (an `AppEmbed`'s beside the app's own) never answer each other's.
 */
export function defineDesktopSink<T>(opts: { name: string; what: string }) {
  const sinks = new WeakMap<DesktopRuntime, InstallSink<T>>();
  const sinkOf = (desk: DesktopRuntime): InstallSink<T> => {
    let sink = sinks.get(desk);
    if (sink === undefined) {
      sink = defineInstallSink<T>({
        name: `${opts.name}:${desk.tabSetId}`,
        what: opts.what,
      });
      sinks.set(desk, sink);
    }
    return sink;
  };
  return {
    /** Install `value` on `desk`; the disposer restores the previous occupant. */
    install: (desk: DesktopRuntime, value: T): (() => void) =>
      sinkOf(desk).install(value),
    /** `desk`'s installed value; throws, naming the slot, when none is. Not from render. */
    peekOrThrow: (desk: DesktopRuntime): T => sinkOf(desk).peekOrThrow(),
  };
}
