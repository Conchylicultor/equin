import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  createPaneStore,
  currentRoutePath,
  parseUrl,
  routeHomeApp,
  setLiveStore,
  setHistoryAdapter,
  appNavSink,
  type HistoryAdapter,
  type ParsedRoute,
  type PaneSlot,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { setFocusedSurfaceId } from "@plugins/primitives/plugins/shortcuts/web";
import { getNavigationType } from "@plugins/primitives/plugins/scope/plugins/app-instance/web";
import { type Placement } from "@plugins/apps-core/core";
import {
  useComposition,
  useDeferredLoadComplete,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  Apps,
  useActiveApp,
  homeApp,
  resolveAppForPath,
  setFocusedApp,
} from "@plugins/apps-core/web";
import {
  makeShellHistoryAdapter,
  serializePaneState,
} from "./shell-history-adapter";
import {
  peekDefaultPlacement,
  peekExitPlacement,
  peekPlacementAllowsEmpty,
  usePlacementCapabilities,
} from "./placement-registry";
import {
  appPathFor,
  loadPersistedTabs,
  normalizeRawPath,
  savePersistedTabs,
  type PersistedSlot,
  type PersistedTab,
  type Tab,
} from "./tabs-store";
import { isDeadUnresolvedLink, loadScopePrefixFor } from "./load-scope";

export interface TabsApi {
  tabs: Tab[];
  /**
   * The focused tab — `undefined` exactly when `tabs` is empty, which only a
   * surface mode that `allowsEmpty` (the desktop) permits.
   */
  focusedTabId: string | undefined;
  /**
   * Per-tab resolved content title (selected page / conversation / song …),
   * keyed by tabId. Absent when the tab is at its app index or its pane has no
   * title; the tab bar falls back to the app name. Published by the per-tab
   * title reporter via {@link TabsApi.setTabTitle}.
   */
  titles: Record<string, string>;
  /** Publish (or clear, with `undefined`) the resolved content title for a tab. */
  setTabTitle(tabId: string, title: string | undefined): void;
  /** The ONE surface rendering mode every tab is displayed under. */
  mode: Placement;
  /**
   * Switch the surface rendering mode (docked / windows / solo). Applies to the
   * whole surface at once — never a single tab — so the modes stay mutually
   * exclusive. Records the outgoing mode for {@link TabsApi.exitToPreviousMode}.
   */
  setMode(mode: Placement): void;
  /** Return to the mode in effect before the current one (solo's exit). */
  exitToPreviousMode(): void;
  /**
   * Always opens a NEW tab for `appId` (multi-instance) under the current
   * surface mode (in windows mode it becomes a new window; docked, a new tab).
   * Returns its tabId.
   */
  openTab(appId: string): string;
  /** Swap `tabId`'s app in place (keeps the tabId) and focus it. */
  replaceTabApp(tabId: string, appId: string): void;
  /**
   * THE sanctioned cross-app navigation: resolve `url` to its owning app (by
   * longest-prefix path match), swap the focused tab to that app in place, and
   * set its route from the URL — all through the live pane store, so
   * the focused tab's `appId` can never drift from the URL. Use this anywhere
   * you'd reach for `window.history.pushState` (enforced by `no-raw-history-nav`).
   *
   * With `{ newTab: true }` the very same resolution instead seeds a BRAND-NEW
   * tab (focused on arrival), leaving the current tab untouched — the in-app
   * equivalent of a browser's middle-click. It is one option on one function
   * rather than a second entry point precisely so the two can never resolve a
   * URL differently: `openTab(appId)` can only reach an app's index, so
   * "open THIS pane in a new tab" had no expressible form before.
   */
  navigate(url: string, opts?: NavigateOptions): void;
  focusTab(tabId: string): void;
  closeTab(tabId: string): void;
  /** Reorder: move the tab `activeId` to the position of `overId`. */
  moveTab(activeId: string, overId: string): void;
}

/** Where a {@link TabsApi.navigate} lands: the focused tab, or a new one. */
export interface NavigateOptions {
  /** Seed a brand-new focused tab instead of re-routing the focused one. */
  newTab?: boolean;
}

const TabsContext = createContext<TabsApi | null>(null);

// Module-level handle to the mounted provider's `navigate`, mirroring the
// `setLiveStore`/`liveStore` pointer in the pane primitive. Lets callers that
// render OUTSIDE `<TabsProvider>` (e.g. the floating action bar, a sibling
// `Core.Root`) reach the one sanctioned cross-app navigation without the hook.
let tabsNavigator: ((url: string, opts?: NavigateOptions) => void) | null =
  null;

function setTabsNavigator(
  fn: ((url: string, opts?: NavigateOptions) => void) | null,
): void {
  tabsNavigator = fn;
}

/**
 * Free-function form of {@link TabsApi.navigate} — the cross-app navigation
 * primitive callable from anywhere, including outside `<TabsProvider>`. Throws
 * if invoked before the provider has mounted (a real bug: there is nothing to
 * navigate yet).
 */
export function navigate(url: string, opts?: NavigateOptions): void {
  if (!tabsNavigator) {
    throw new Error("navigate() called before <TabsProvider> mounted.");
  }
  tabsNavigator(url, opts);
}

// Module-level mirror of the ONE per-surface rendering mode + its setters,
// mirroring the `tabsNavigator` pattern above. Lets out-of-provider callers (the
// floating action bar's mode control, the global Esc shortcut, the action-bar
// pin guard) read/drive the surface mode without the `useTabs` hook. A
// subscribable snapshot (useSurfaceMode) keeps those consumers reactive.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: the ONE surface rendering mode, mirroring tabsNavigator/focusedSurfaceId. Driven by single global chrome (the floating-bar mode control + global Esc) outside any surface tree, so it cannot be a per-surface scoped store.
let surfaceMode: Placement = "";
let setSurfaceModeFn: ((mode: Placement) => void) | null = null;
let exitToPreviousModeFn: (() => void) | null = null;
const surfaceModeSubscribers = new Set<() => void>();

function publishSurfaceMode(
  mode: Placement,
  setter: ((mode: Placement) => void) | null,
  exit: (() => void) | null,
): void {
  setSurfaceModeFn = setter;
  exitToPreviousModeFn = exit;
  if (mode !== surfaceMode) {
    surfaceMode = mode;
    for (const fn of surfaceModeSubscribers) fn();
  }
}

// Page-global by design, like surfaceMode above: whether the ONE tab set is empty, read by the apps layout (the provider's parent) to keep its bare-`/` canonicalization off the empty surface's own URL.
let surfaceEmpty = false;

/**
 * Whether the surface holds no tab at all (the desktop with every window
 * closed). One-shot read for effects: the apps layout renders ABOVE the
 * provider, and the empty surface's URL is bare `/`, which it would otherwise
 * canonicalize to the home app.
 */
export function peekSurfaceEmpty(): boolean {
  return surfaceEmpty;
}

/**
 * Imperatively set the surface rendering mode from anywhere — the persistent
 * home for the mode control on the floating action bar, the fullscreen button,
 * and the pin guard. No-op (rather than throw) before the provider mounts: a
 * stray keystroke/click pre-mount is benign, not a bug.
 */
export function setSurfaceMode(mode: Placement): void {
  setSurfaceModeFn?.(mode);
}

/**
 * Return the surface to the mode it was in before the current one — the solo
 * (fullscreen) exit affordance. Soloing from a window returns to windows mode;
 * soloing from docked returns to docked. No-op before the provider mounts.
 */
export function exitToPreviousMode(): void {
  exitToPreviousModeFn?.();
}

/**
 * Non-hook read of the surface mode — for plain-function callers (e.g. a
 * shortcut `when`/`handler` guard) that can't use the hook form.
 */
export function getSurfaceMode(): Placement {
  return surfaceMode;
}

/**
 * Reactive read of the surface mode, callable outside `<TabsProvider>`. Backs
 * the floating-bar mode control, the solo exit, and the chrome theme scope.
 */
export function useSurfaceMode(): Placement {
  return useSyncExternalStore(
    (cb) => {
      surfaceModeSubscribers.add(cb);
      return () => surfaceModeSubscribers.delete(cb);
    },
    () => surfaceMode,
    () => surfaceMode,
  );
}

export function useTabs(): TabsApi {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error("useTabs() called outside <TabsProvider>.");
  }
  return ctx;
}

type AppList = ReturnType<typeof Apps.App.useContributions>;

/** Build a fresh, non-live background store bound to an app's base path. */
function makeBackgroundStore(appId: string, apps: AppList): PaneStore {
  const store = createPaneStore({ live: false });
  store.setBasePath(appPathFor(appId, apps));
  return store;
}

/** Rebuild a persisted background tab's store + route (route held in memory). */
function rebuildBackgroundTab(persisted: PersistedTab, apps: AppList): Tab {
  const store = makeBackgroundStore(persisted.appId, apps);
  if (persisted.route.length > 0) {
    store.restoreRoute(persisted.route);
  } else if (persisted.rawPath) {
    // A backgrounded PENDING tab (empty route + a non-empty rawPath it was
    // waiting to resolve) survives the reload as pending — re-seed it so the tab
    // reopens on its unresolved URL, not blank. A bare-root tab (rawPath "") is
    // falsy here and correctly stays a resolved-empty index.
    store.seedPending(persisted.rawPath);
  }
  return {
    tabId: persisted.tabId,
    appId: persisted.appId,
    store,
  };
}

interface BootState {
  tabs: Tab[];
  focusedTabId: string | undefined;
  /** Restored surface mode (registry default until `surface` registers). */
  mode: Placement;
}

/**
 * What a tab is seeded with when it is activated (made the live focused tab).
 * `route` is a resolved cross-app deep link; `pending` is a not-yet-resolvable
 * URL (its pane's plugin is still loading). Absent target = a plain focus switch
 * that keeps whatever route the tab already holds.
 */
type ActivateTarget =
  { kind: "route"; route: PaneSlot[] } | { kind: "pending"; rawPath: string };

/**
 * The tabId the CURRENT history entry names, but ONLY on a browser back/forward
 * load. A history entry is a complete snapshot, so on a traversal the entry is
 * authoritative about which tab the user was looking at — more so than the
 * instance's persisted `focusedTabId`, which records wherever the instance was
 * left rather than where this particular entry sat. On every other nav type the
 * entry describes some earlier moment of *this* load's own instance (or nothing
 * at all), so it must not steer focus: `undefined`.
 */
function backForwardEntryTabId(): string | undefined {
  if (getNavigationType() !== "back_forward") return undefined;
  const state = window.history.state as { tabId?: unknown } | null;
  return typeof state?.tabId === "string" ? state.tabId : undefined;
}

/**
 * Construct the initial tab set exactly once: restore from sessionStorage, or
 * seed a single tab from the current URL's app. Pure store construction only —
 * the live-store wiring side-effect runs separately in a one-time effect.
 *
 * `seedTabId` is the tabId the history entry names on a back/forward load (see
 * {@link backForwardEntryTabId}); it is a parameter purely so tests can drive
 * it directly. It is used twice: to pick which restored tab is focused, and —
 * when the entry's generation has been evicted so there is nothing to restore —
 * as the id of the single minted tab, so the shell adapter's `restore()` still
 * recognises the entries around it instead of a freshly-minted stranger.
 */
/**
 * The URL's slots, each carrying the uuid of the persisted slot at its position
 * when that slot is the same pane at the same params — the instance a reload
 * brings back. Any slot that differs is a new instance and keeps its fresh id.
 */
function keepInstanceIds(
  slots: readonly PaneSlot[],
  persisted: readonly PersistedSlot[],
): PaneSlot[] {
  return slots.map((slot, i) => {
    const prev = persisted[i];
    return prev !== undefined &&
      prev.paneId === slot.paneId &&
      sameParams(prev.params, slot.params)
      ? { ...slot, uuid: prev.uuid }
      : slot;
  });
}

function sameParams(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
}

/** The composition's home app when it is registered, else undefined. */
function registeredHome(apps: AppList, homeId: string | null) {
  const home = homeApp(apps, homeId);
  return home.kind === "app" ? home.app : undefined;
}

export function bootTabs(
  apps: AppList,
  seedAppId: string,
  seedTabId: string | undefined = backForwardEntryTabId(),
): BootState {
  // The current URL — not the persisted focus — is authoritative for which
  // app/pane is focused on load. Resolve it up front (same source of truth as
  // the cross-app `navigate()`), so a reload or deep link always lands on the
  // URL's app, never the last-focused app from a previous session.
  const resolved = resolveAppForPath(currentRoutePath(), apps);
  const urlAppId = resolved?.app.id ?? seedAppId;
  // Parse the URL into the tri-state route. A URL that matches no app (bare `/`,
  // or a stale link — apps-layout redirects it) is treated as a bare-root match,
  // preserving the historical "empty route ⇒ index" behavior for the seed tab.
  const parsed: ParsedRoute = resolved
    ? parseUrl(resolved.routePath)
    : { status: "matched", slots: [] };

  // Rebuild every persisted tab as a background tab. Keep-alive must survive a
  // reload, so no other app's tab is dropped; the focused tab is chosen and made
  // live from the URL below.
  const persisted = loadPersistedTabs();
  // The instance was left EMPTY (the desktop with every window closed) and the
  // address bar is still the empty surface's bare root: come back empty. A URL
  // naming an app opens it, as on any boot. `TabsProvider` seeds the home app
  // once the restored mode turns out not to allow an empty surface.
  if (persisted?.tabs.length === 0 && !resolved) {
    return { tabs: [], focusedTabId: undefined, mode: persisted.mode ?? "" };
  }
  const tabs: Tab[] = (persisted?.tabs ?? []).map((p) =>
    rebuildBackgroundTab(p, apps),
  );

  // Pick which tab the URL focuses. The entry's own tab wins where it is
  // available (a back/forward snapshot names the exact tab that was on screen —
  // plain single-step Back already agrees with the rules below, but jumping
  // straight to an older entry via the history dropdown does not), then the
  // persisted focused tab when it already belongs to the URL's app (the normal
  // reload), else the first tab on that app, else a fresh tab so the URL's app
  // is never silently dropped.
  //
  // The entry's tab is honoured only when it also belongs to the URL's app:
  // an entry stamped alongside this URL always does, so a disagreement means
  // the tab was re-apped after the entry was written — and there the URL is
  // authoritative, exactly as in every other branch here. (Focusing a tab whose
  // app contradicts the URL would bind its store to one app's base path while
  // seeding it with another app's parsed route.)
  let focusIdx = seedTabId
    ? tabs.findIndex((t) => t.tabId === seedTabId && t.appId === urlAppId)
    : -1;
  if (focusIdx < 0) {
    focusIdx = tabs.findIndex(
      (t) => t.tabId === persisted?.focusedTabId && t.appId === urlAppId,
    );
  }
  if (focusIdx < 0) focusIdx = tabs.findIndex((t) => t.appId === urlAppId);
  if (focusIdx < 0) {
    // Nothing to focus. On a back/forward into an EVICTED generation this is
    // the whole restoration: a single-tab instance built from the entry's own
    // snapshot, reusing its tabId so the adapter keeps recognising the entries
    // around it. (Guarded against an id already in the set, so reuse can never
    // mint a duplicate.)
    const reuseSeed = !!seedTabId && !tabs.some((t) => t.tabId === seedTabId);
    tabs.push({
      tabId: reuseSeed ? seedTabId! : crypto.randomUUID(),
      appId: urlAppId,
      store: makeBackgroundStore(urlAppId, apps),
    });
    focusIdx = tabs.length - 1;
  }

  // Promote the chosen tab to the live focused tab, hydrating its route from the
  // address bar (the URL wins over the tab's own persisted route). Seed while
  // still background so it's an in-memory update with no spurious history entry,
  // then flip it live. Four branches over the tri-state parse:
  //
  //   1. matched, non-empty  ⇒ the registry already has these panes; restore them.
  //   2. matched, empty      ⇒ a genuine bare app root ⇒ index.
  //   3. unresolved, but the persisted focused tab held a non-empty route for
  //      THIS exact URL (a plain reload of the same deep link) ⇒ restore the
  //      persisted slots INSTANTLY — no spinner, no wait for the deferred tier.
  //   4. unresolved, anything else (a different / never-seen deep link) ⇒ seed a
  //      pending route so the fallback surface shows a spinner until the pane's
  //      plugin loads (or a not-found once loading settles), never a stale pane.
  const focused = tabs[focusIdx]!;
  focused.store.setBasePath(appPathFor(focused.appId, apps));
  const persistedFocused = persisted?.tabs.find(
    (t) => t.tabId === focused.tabId,
  );
  if (parsed.status === "matched" && parsed.slots.length > 0) {
    // A plain reload of the URL the tab was on is the SAME panes coming back:
    // they keep their instance ids. The URL still decides which panes there are.
    focused.store.restoreRoute(
      persistedFocused !== undefined &&
        resolved !== undefined &&
        persistedFocused.rawPath === normalizeRawPath(resolved.routePath)
        ? keepInstanceIds(parsed.slots, persistedFocused.route)
        : parsed.slots,
    );
  } else if (parsed.status === "matched") {
    focused.store.clearRoute();
  } else if (
    persistedFocused?.route.length &&
    persistedFocused.rawPath === parsed.rawPath
  ) {
    focused.store.restoreRoute(persistedFocused.route);
  } else {
    focused.store.seedPending(parsed.rawPath);
  }
  focused.store.live = true;

  // Restore the persisted surface mode, or seed "" — deliberately NOT the
  // registry default. `bootTabs` runs inside a `useState` initializer, i.e.
  // during render, where sampling the placement registry would read whatever
  // happened to be installed at that instant and freeze it. It never needed to:
  // `TabsProvider` re-derives the mode against `usePlacementCapabilities()` on
  // every render, and "" is not a registered id, so it resolves to the default
  // the moment the registry populates — reactively, which the sample was not.
  const mode = persisted?.mode ?? "";

  return { tabs, focusedTabId: focused.tabId, mode };
}

/**
 * Owns the open-tab set and the focus model. Each tab has its own pane store;
 * exactly one store is `live` (the focused tab's). On focus switch we flip
 * liveness, repoint the imperative live store, set the new store's base path,
 * and assert its route into the URL so `useActiveApp` (URL-driven) resolves to
 * the focused tab. Persists to sessionStorage on every structural/route change.
 */
export function TabsProvider({ children }: { children: ReactNode }): ReactNode {
  const apps = Apps.App.useContributions();
  const initialApp = useActiveApp();
  // The composition's declared home app id — fixed for the page's lifetime
  // (baked into the web registry), so read once and used in callbacks directly.
  const { home: homeId } = useComposition();

  // Stable refs so callbacks read the latest apps without re-creating.
  const appsRef = useLatestRef(apps);

  const [{ tabs: initialTabs, focusedTabId: initialFocus, mode: initialMode }] =
    useState(() =>
      bootTabs(apps, initialApp?.id ?? registeredHome(apps, homeId)?.id ?? ""),
    );
  const [tabs, setTabs] = useState<Tab[]>(initialTabs);
  const [focusedTabId, setFocusedTabId] = useState<string | undefined>(
    initialFocus,
  );
  // The ONE surface rendering mode (docked / windows / solo). Per-surface, never
  // per-tab: every tab is displayed under this single value, so two modes can
  // never be visible at once. `previousMode` backs the solo (fullscreen) exit.
  const [rawMode, setModeState] = useState<Placement>(initialMode);
  const previousModeRef = useRef<Placement>(initialMode);
  // Resolve the stored mode against the placement registry: `""` (the boot seed
  // when the surface hasn't registered yet) and a stale id (a removed placement
  // sub-plugin) both resolve to the registered default — the same resolution
  // SurfaceBody applies at render. Publishing the RESOLVED mode is what keeps
  // every consumer (chrome theme scope, the mode control's highlight, the
  // persisted payload) agreeing with what the surface actually paints; before
  // this, a cold boot published `""` forever and the rail/tab bar dropped the
  // focused app's theme while the docked tab kept it.
  const capabilities = usePlacementCapabilities();
  const mode =
    capabilities !== null && !capabilities.ids.has(rawMode)
      ? capabilities.defaultId
      : rawMode;
  // Per-tab content titles, published by the title reporter mounted inside each
  // tab's pane surface. Derived (not persisted): each tab re-reports on mount.
  const [titles, setTitles] = useState<Record<string, string>>({});

  const setTabTitle = useCallback(
    (tabId: string, title: string | undefined) => {
      setTitles((prev) => {
        if ((prev[tabId] ?? undefined) === title) return prev;
        const next = { ...prev };
        if (title === undefined) delete next[tabId];
        else next[tabId] = title;
        return next;
      });
    },
    [],
  );

  // Latest tabs/focus in refs for the persistence subscriptions + actions.
  // HYBRID, not useLatestRef: these are ALSO written authoritatively inside the
  // action callbacks (tabsRef.current = nextTabs / focusedRef.current = tabId in
  // focusTab/openTab/closeTab/moveTab/setMode/replaceTabAppWithRoute) so a
  // callback's mutation is visible to the next callback in the SAME tick before
  // React re-renders. A useLatestRef render-sync would clobber those in-flight
  // writes on the next render, so the render-sync stays explicit and documented.
  const tabsRef = useRef(tabs);
  // eslint-disable-next-line react-hooks/refs -- intentional render-sync of a hybrid ref also written imperatively inside the action callbacks; see the note above.
  tabsRef.current = tabs;
  const focusedRef = useRef(focusedTabId);
  // eslint-disable-next-line react-hooks/refs -- intentional render-sync of a hybrid ref also written imperatively inside the action callbacks; see the note above.
  focusedRef.current = focusedTabId;
  // Hybrid ref (also written imperatively in setMode) so persist() reads the
  // latest surface mode in the same tick a mode change fires.
  const modeRef = useRef(mode);
  // eslint-disable-next-line react-hooks/refs -- intentional render-sync of a hybrid ref also written imperatively inside setMode; see the note above.
  modeRef.current = mode;

  // The installed shell history adapter — the one writer for the empty
  // surface's URL, which no pane store can write (none is live).
  const adapterRef = useRef<HistoryAdapter | null>(null);

  const persist = useCallback(() => {
    savePersistedTabs(tabsRef.current, focusedRef.current, modeRef.current);
  }, []);

  // One-time: point the imperative live store at the initially-focused tab's
  // store. (bootTabs already created it `live`; this wires the module pointer.)
  const wiredRef = useRef(false);
  // eslint-disable-next-line react-hooks/refs -- intentional run-once guard read+written during render: wires the module-level live-store pointer to the initially-focused tab exactly once on mount (a one-shot init, not a latest-value sync).
  if (!wiredRef.current) {
    wiredRef.current = true;
    const focused = initialTabs.find((t) => t.tabId === initialFocus);
    if (focused) setLiveStore(focused.store);
  }

  // Subscribe to each store's route changes to persist on navigation. Re-wired
  // whenever the tab set changes (covers add/close); focus/structure changes
  // call persist() directly.
  useEffect(() => {
    persist();
    const unsubs = tabs.map((t) => t.store.subscribeRoute(persist));
    return () => {
      for (const u of unsubs) u();
    };
  }, [tabs, persist]);

  /**
   * Flip liveness from the current focused store onto `next` and mirror its
   * route into the URL. When `target` is given (cross-app navigation), it is
   * seeded into the still-background store FIRST — a background seed is an
   * in-memory-only update (no history op), so the single live mirror below lands
   * directly on the target URL in one `replaceState`, with no stray intermediate
   * entry at the bare app root and no double event dispatch.
   *
   * The URL mirror is derived from the store's CURRENT state, not from `target`:
   * a resolved route is asserted via `setRoute`, a pending (unresolved) one via
   * `navigatePending`. Deriving from state is load-bearing for the no-target
   * focus switch — focusing a background PENDING tab must re-assert its pending
   * URL, NOT `setRoute([])` an empty resolved route over it (which would wipe the
   * pending state and jump the address bar to the bare app root).
   */
  const activate = useCallback(
    (next: Tab, target?: ActivateTarget, mode: "push" | "replace" = "push") => {
      surfaceEmpty = false;
      const current = tabsRef.current.find(
        (t) => t.tabId === focusedRef.current,
      );
      if (current && current.tabId !== next.tabId) current.store.live = false;
      next.store.setBasePath(appPathFor(next.appId, appsRef.current));
      // Seed the target while still background (in-memory only, no history op).
      if (target?.kind === "route") next.store.setRoute(target.route);
      else if (target?.kind === "pending")
        next.store.seedPending(target.rawPath);
      next.store.live = true;
      setLiveStore(next.store);
      // Point the focused-tab ref at `next` BEFORE mirroring: the shell adapter's
      // commit stamps the FOCUSED tab's `{ tabId, appId }` into the new history
      // entry, so the ref must already name `next`, not the outgoing tab. This is
      // the imperative half of the hybrid ref — callers also set it +
      // `setFocusedTabId` for the React re-render (a redundant, identical write).
      focusedRef.current = next.tabId;
      // Mirror the (now possibly seeded) in-memory route into the URL so it
      // matches the focused tab. `mode` decides push vs replace: user-initiated
      // tab/app switches PUSH (a new snapshot Back can return to — the headline
      // fix, cross-app nav used to hard-replace); boot + close-tab refocus
      // REPLACE (a correction that must not be independently reachable).
      const state = next.store.getRouteState();
      const replace = mode === "replace";
      if (state.kind === "unresolved") {
        next.store.navigatePending(state.rawPath, replace);
      } else {
        next.store.setRoute(state.slots, replace);
      }
    },
    [],
  );

  // Focus-flip WITHOUT mirroring to history — the back/forward restore path,
  // where the browser has ALREADY advanced URL + history.state. The caller
  // restores the route from history.state via `handleLocationChange`, so this
  // never seeds a target and never writes history: restoration is a pure read
  // of the snapshot, never a new entry.
  const activateWithoutMirror = useCallback((next: Tab) => {
    surfaceEmpty = false;
    const current = tabsRef.current.find((t) => t.tabId === focusedRef.current);
    if (current && current.tabId !== next.tabId) current.store.live = false;
    next.store.setBasePath(appPathFor(next.appId, appsRef.current));
    next.store.live = true;
    setLiveStore(next.store);
    // Point the focused-tab ref at `next` so the adapter's subsequent
    // `restoreLiveRoute()` resolves the live store as `next`'s.
    focusedRef.current = next.tabId;
  }, []);

  const focusTab = useCallback(
    (tabId: string) => {
      const next = tabsRef.current.find((t) => t.tabId === tabId);
      if (!next || focusedRef.current === tabId) return;
      activate(next);
      focusedRef.current = tabId;
      setFocusedTabId(tabId);
      persist();
    },
    [activate, persist],
  );

  /**
   * Mint a new tab for `appId`, seeded with `target` (omit for the app's index),
   * and focus it. The new tab is displayed under the current surface mode (a new
   * window in windows mode, a docked tab otherwise) — the surface owns the mode,
   * not the tab. Seeding happens inside `activate`, i.e. while the store is
   * still background, so the target URL lands in ONE history op rather than a
   * stray entry at the bare app root followed by the real one.
   *
   * The single tab-minting path: both the `+` button (`openTab`) and
   * `navigate(url, { newTab: true })` come through here.
   */
  const openTabWith = useCallback(
    (appId: string, target?: ActivateTarget): string => {
      const tabId = crypto.randomUUID();
      const store = makeBackgroundStore(appId, appsRef.current);
      const tab: Tab = { tabId, appId, store };
      const nextTabs = [...tabsRef.current, tab];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      activate(tab, target);
      focusedRef.current = tabId;
      setFocusedTabId(tabId);
      persist();
      return tabId;
    },
    [activate, persist],
  );

  /** Open a new tab for `appId` at its index. Used by the `+` new-tab button. */
  const openTab = useCallback(
    (appId: string): string => openTabWith(appId),
    [openTabWith],
  );

  // Swap a tab's app in place (keeps the tabId + position), rebinding a fresh
  // store to the new app. `mirror` decides how liveness lands:
  //   • mirror=true  — author-initiated (rail click, cross-app navigate, Home
  //     launch): seed `target` and PUSH a new composite entry, so the focused
  //     tab's appId always matches the URL and Back can return to the prior app.
  //   • mirror=false — back/forward restoration: make the new store live WITHOUT
  //     writing history; the shell adapter restores the route from history.state.
  // Shared by `replaceTabAppWith*` (mirror=true) and the shell adapter's restore
  // path (mirror=false) so the app-swap mechanics live in exactly one place.
  const rebuildTabApp = useCallback(
    (
      tabId: string,
      appId: string,
      target: ActivateTarget | undefined,
      // How the move reaches history: a new entry, one rewritten in place, or
      // none (a restore, where the browser already moved).
      opts: { mirror: "push" | "replace" | false },
    ) => {
      const idx = tabsRef.current.findIndex((t) => t.tabId === tabId);
      if (idx < 0) return;
      tabsRef.current[idx]!.store.live = false;
      const store = makeBackgroundStore(appId, appsRef.current);
      const tab: Tab = { tabId, appId, store };
      const nextTabs = [...tabsRef.current];
      nextTabs[idx] = tab;
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      if (opts.mirror) activate(tab, target, opts.mirror);
      else activateWithoutMirror(tab);
      focusedRef.current = tabId;
      setFocusedTabId(tabId);
      setFocusedApp(appId);
      persist();
    },
    [activate, activateWithoutMirror, persist],
  );

  // The launcher (Home) tab and the rail navigate INTO the picked app instead of
  // spawning a tab beside it; a cross-app deep-link lands the focused tab
  // directly on its target route.
  const replaceTabAppWithRoute = useCallback(
    (tabId: string, appId: string, route: PaneSlot[]) =>
      rebuildTabApp(tabId, appId, { kind: "route", route }, { mirror: "push" }),
    [rebuildTabApp],
  );

  // Cross-app twin of `replaceTabAppWithRoute` for a not-yet-resolvable deep
  // link: swap the focused tab to `appId` and seed a PENDING route (rawPath) so
  // the URL is preserved and the fallback surface shows a spinner until the
  // target pane's plugin loads.
  const replaceTabAppWithPending = useCallback(
    (tabId: string, appId: string, rawPath: string) =>
      rebuildTabApp(
        tabId,
        appId,
        { kind: "pending", rawPath },
        { mirror: "push" },
      ),
    [rebuildTabApp],
  );

  const replaceTabApp = useCallback(
    (tabId: string, appId: string) => replaceTabAppWithRoute(tabId, appId, []),
    [replaceTabAppWithRoute],
  );

  // Refocus an EXISTING tab by id WITHOUT writing history — the shell adapter's
  // restore path when a back/forward lands on a tab whose app already matches
  // the snapshot (no store rebuild, just a liveness flip + focus-state update).
  const refocusForRestore = useCallback(
    (tabId: string) => {
      const next = tabsRef.current.find((t) => t.tabId === tabId);
      if (!next) return;
      activateWithoutMirror(next);
      focusedRef.current = tabId;
      setFocusedTabId(tabId);
    },
    [activateWithoutMirror],
  );

  const navigate = useCallback(
    (url: string, opts?: NavigateOptions) => {
      // Strip any query/hash — routing is path-based.
      const pathname = url.split(/[?#]/)[0] ?? url;
      const resolved = resolveAppForPath(pathname, appsRef.current);
      if (!resolved) {
        // No registered app owns this path, so navigation cannot proceed. Every
        // real caller passes an app-rooted path (/agents/…, /story/…); reaching
        // here means a caller built a malformed link — e.g. a notification linkTo
        // missing its /agents prefix. Throw instead of silently no-opping: an
        // uncaught error in this event-handler is caught by the global crash
        // collector and filed as a deduped report+task, so the structural bug
        // surfaces and gets fixed rather than manifesting as a dead, silent click.
        throw new Error(
          `navigate(): no registered app owns path "${pathname}" — the link is unrooted or points to an unregistered app`,
        );
      }
      const parsed = parseUrl(resolved.routePath);
      const focused = tabsRef.current.find(
        (t) => t.tabId === focusedRef.current,
      );
      if (parsed.status === "unresolved") {
        // NOTE: the dead-link decision below is a property of the URL alone, so
        // it is deliberately made BEFORE the newTab branch — a dead link must
        // throw whether it was left-clicked or middle-clicked, never quietly
        // spawn a tab that spins forever.
        // The path resolves to no registered pane RIGHT NOW. If the deferred tier
        // has settled AND nothing under this app's subtree failed to load, the
        // pane will never appear — the link is dead (a stale link, or a pane that
        // loaded without registering). Throw, mirroring the unmatched-app throw
        // above: an uncaught error here is caught by the global crash collector
        // and filed as a deduped report+task, so a dead deep link surfaces loudly
        // rather than seeding a route that spins forever. Otherwise the pane may
        // still arrive (tier loading) or its app failed to load (error surface) —
        // seed a pending route so the URL is preserved and the fallback renders.
        const prefix = loadScopePrefixFor(resolved.app._pluginId);
        if (isDeadUnresolvedLink(prefix)) {
          throw new Error(
            `navigate(): path "${pathname}" resolves to no registered pane in app "${resolved.app.id}" — the link is dead (deferred load settled with no load error under "${prefix || "<app root>"}")`,
          );
        }
        if (opts?.newTab) {
          openTabWith(resolved.app.id, {
            kind: "pending",
            rawPath: parsed.rawPath,
          });
          return;
        }
        if (focused && focused.appId === resolved.app.id) {
          focused.store.navigatePending(parsed.rawPath);
          return;
        }
        // An empty surface has no tab to re-route: the link opens one.
        if (!focused) {
          openTabWith(resolved.app.id, {
            kind: "pending",
            rawPath: parsed.rawPath,
          });
          return;
        }
        replaceTabAppWithPending(
          focused.tabId,
          resolved.app.id,
          parsed.rawPath,
        );
        return;
      }
      const route = parsed.slots;
      if (opts?.newTab || !focused) {
        // A new tab is always a fresh tab, even when the target app is the one
        // already focused — that is what makes this the in-app middle-click.
        // An empty surface has no tab to re-route, so the link opens one too.
        openTabWith(resolved.app.id, { kind: "route", route });
        return;
      }
      if (focused && focused.appId === resolved.app.id) {
        // Already on this app — set the route on its live store (normal push,
        // preserving a back target).
        focused.store.setRoute(route);
        return;
      }
      // Cross-app: swap the focused tab's app in place AND seed the target
      // route, so the focused tab's appId always matches the URL (no desync) —
      // consistent with the rail's in-place app switch.
      replaceTabAppWithRoute(focused.tabId, resolved.app.id, route);
    },
    [replaceTabAppWithRoute, replaceTabAppWithPending, openTabWith],
  );

  // Push focus changes into the shortcuts focused-surface signal (push-based, no
  // polling) so surface-scoped shortcuts read the focused surface from the
  // window keydown handler outside any React subtree.
  useEffect(() => {
    setFocusedSurfaceId(focusedTabId);
  }, [focusedTabId]);

  // Publish the focused tab's app to the chrome-identity module store on every
  // focus/app change (and on boot). Chrome rendered OUTSIDE a surface (rail, tab
  // bar, theme scope) reads this via `useActiveApp` → `useFocusedAppId`, so it
  // tracks the focused tab's app rather than parsing the URL — the theme can
  // never diverge from what the focused surface actually shows. The shell
  // adapter also publishes synchronously during a back/forward restore; this
  // steady-state effect covers every other focus/app transition.
  const focusedAppId = tabs.find((t) => t.tabId === focusedTabId)?.appId;
  useEffect(() => {
    setFocusedApp(focusedAppId);
  }, [focusedAppId]);

  // Publish the cross-app navigator at module scope so out-of-provider callers
  // (the floating bar, a sibling Core.Root) can reach it via the free
  // `navigate()` export. Mirrors the pane primitive's `setLiveStore` handle.
  //
  // The pane primitive gets the same function through its own sink: a pane that
  // names a home app must be able to reach that app when promoted, and the pane
  // layer sits BELOW this one (tabs imports pane), so it cannot call in
  // directly. Same seam shape as `setHistoryAdapter` above.
  useEffect(() => {
    setTabsNavigator(navigate);
    // The sink's disposer restores the PREVIOUS occupant rather than clearing,
    // and is inert once superseded — so a StrictMode double-mount (install,
    // re-install, dispose the first) cannot empty a slot that was just filled.
    const uninstallAppNav = appNavSink.install(navigate);
    return () => {
      setTabsNavigator(null);
      uninstallAppNav();
    };
  }, [navigate]);

  // A tab never shows another app's route (see `routeHomeApp`). The opener
  // already hands such a route to its app; this catches every way that skips
  // the opener — a hand-typed or stale URL, a deep link whose pane registered
  // after boot, a back/forward into an entry written before the rule — and
  // moves the focused tab to the route's app, REPLACING the entry so Back never
  // returns to the stranded one. Deferred a microtask: a pending route resolves
  // during render (the registry sync), where rebuilding the tab set would be a
  // state update in the middle of another component's render.
  const focusedStore = tabs.find((t) => t.tabId === focusedTabId)?.store;
  useEffect(() => {
    if (!focusedStore) return;
    let disposed = false;
    const rehome = () => {
      if (disposed) return;
      const state = focusedStore.getRouteState();
      if (state.kind !== "resolved") return;
      const home = routeHomeApp(state.slots);
      const tab = tabsRef.current.find((t) => t.store === focusedStore);
      if (!home || !tab || home.id === tab.appId) return;
      // A composition without the route's app has nowhere to send it.
      if (!appsRef.current.some((a) => a.id === home.id)) return;
      rebuildTabApp(
        tab.tabId,
        home.id,
        { kind: "route", route: state.slots },
        { mirror: "replace" },
      );
    };
    rehome();
    const unsubscribe = focusedStore.subscribeRoute(() =>
      queueMicrotask(rehome),
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [focusedStore, rebuildTabApp, appsRef]);

  // Fill an empty surface with a fresh home-app tab, focused — for a mode that
  // does not allow an empty surface. Bails when the home is not registered (no
  // app at all, or its shell failed: nothing to seed, and never another app in
  // its place). Replace: the top entry names a tab that is gone (or the empty
  // surface) — a correction, not an independently-reachable navigation.
  const seedHome = useCallback(() => {
    const seedApp = registeredHome(appsRef.current, homeId);
    if (!seedApp) return;
    const seedId = crypto.randomUUID();
    const seed: Tab = {
      tabId: seedId,
      appId: seedApp.id,
      store: createPaneStore({ live: false }),
    };
    tabsRef.current = [seed];
    setTabs([seed]);
    activate(seed, undefined, "replace");
    focusedRef.current = seedId;
    setFocusedTabId(seedId);
    persist();
  }, [activate, persist, homeId]);

  const closeTab = useCallback(
    (tabId: string) => {
      const prev = tabsRef.current;
      const idx = prev.findIndex((t) => t.tabId === tabId);
      if (idx < 0) return;
      const remaining = prev.filter((t) => t.tabId !== tabId);
      const wasFocused = focusedRef.current === tabId;
      setTabTitle(tabId, undefined);

      if (remaining.length === 0) {
        if (!peekPlacementAllowsEmpty(modeRef.current)) {
          seedHome();
          return;
        }
        // The mode allows an empty surface (the desktop): nothing is focused,
        // no store is live, and the address bar shows the empty surface's bare
        // root.
        prev[idx]!.store.live = false;
        tabsRef.current = [];
        setTabs([]);
        focusedRef.current = undefined;
        setFocusedTabId(undefined);
        surfaceEmpty = true;
        // Replace, like every close-tab correction: the top entry named the
        // tab just closed. With nothing focused the entry carries no tab.
        adapterRef.current?.commit({
          url: "/",
          state: { route: [] },
          mode: "replace",
        });
        persist();
        return;
      }

      tabsRef.current = remaining;
      setTabs(remaining);

      if (wasFocused) {
        // Focus a neighbor: the tab that shifted into this index, else the new
        // last one.
        const neighbor = remaining[Math.min(idx, remaining.length - 1)]!;
        // Replace: the top entry points at the tab we just closed, so refocusing
        // the neighbor is a correction, not a new Back target.
        activate(neighbor, undefined, "replace");
        focusedRef.current = neighbor.tabId;
        setFocusedTabId(neighbor.tabId);
      }
      persist();
    },
    [activate, persist, setTabTitle, seedHome],
  );

  // Reorder the open-tab set: move `activeId` to `overId`'s position. Pure array
  // reordering — focus and store liveness are untouched (the focused tabId keeps
  // its identity, just changes index). Persists the new order via the unchanged
  // sessionStorage serializer (array order is the source of truth).
  const moveTab = useCallback(
    (activeId: string, overId: string) => {
      const prev = tabsRef.current;
      const from = prev.findIndex((t) => t.tabId === activeId);
      const to = prev.findIndex((t) => t.tabId === overId);
      if (from < 0 || to < 0 || from === to) return;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      tabsRef.current = next;
      setTabs(next);
      persist();
    },
    [persist],
  );

  // Switch the ONE surface rendering mode. Records the outgoing mode so solo's
  // exit can pop back to it. Pure surface state — no tab/focus/liveness change,
  // so the surface re-renders every (still-mounted) tab under the new mode with
  // no reload (Chrome-style keep-alive).
  const setMode = useCallback(
    (next: Placement) => {
      if (modeRef.current === next) return;
      previousModeRef.current = modeRef.current;
      modeRef.current = next;
      setModeState(next);
      persist();
      // Leaving the desktop with no window open: the next mode needs a tab.
      if (tabsRef.current.length === 0 && !peekPlacementAllowsEmpty(next)) {
        seedHome();
      }
    },
    [persist, seedHome],
  );

  // An empty surface restored by boot whose mode turns out not to allow one (a
  // removed mode, or one the registry resolves elsewhere): seed the home app
  // once the placements are known. A stored mode not registered YET may be a
  // placement of the deferred tier (the desktop's is) — judge it only once that
  // tier settled, or every reload of an empty desktop would come back with a
  // Home window.
  const deferredComplete = useDeferredLoadComplete();
  useEffect(() => {
    if (capabilities === null || tabs.length > 0) return;
    if (!capabilities.ids.has(rawMode) && !deferredComplete) return;
    if (!capabilities.allowsEmpty.has(mode)) seedHome();
  }, [capabilities, tabs.length, rawMode, mode, deferredComplete, seedHome]);

  useEffect(() => {
    surfaceEmpty = tabs.length === 0;
  }, [tabs.length]);

  // Return to the mode in effect before the current one (solo's exit). Falls
  // back to another registered mode if the previous one is unknown or equals
  // the current — always the case when the surface booted into solo as its
  // default — so the surface is never left stuck in solo.
  const exitToPreviousMode = useCallback(() => {
    const prev = previousModeRef.current;
    setMode(
      prev && prev !== modeRef.current
        ? prev
        : peekExitPlacement(modeRef.current),
    );
  }, [setMode]);

  // Install the shell (app-aware) history adapter so the pane store's push/
  // replace intents stamp `{ tabId, appId }` and browser back/forward restores
  // the whole snapshot. Built INSIDE the effect (ref reads are effect-only, not
  // render) over the stable mutation callbacks; every read goes through the
  // hybrid refs so `restore()` always sees the latest tabs/focus — matching the
  // refs contract above. The mutation deps expose only the history-free variants:
  // restoration must never re-enter the commit path.
  //
  // Replace-stamp the initial composite so `history.state` carries the focused
  // tab's identity from the very FIRST entry — back/forward works immediately,
  // and survives reload (tabIds are sessionStorage-stable, so a stamp written
  // before a reload still matches after it). Teardown is the sink's own
  // disposer, which puts the previous occupant — the standalone default
  // adapter — back. The dep callbacks are stable, so this runs once.
  useEffect(() => {
    const adapter = makeShellHistoryAdapter({
      focused: () => {
        const t = tabsRef.current.find((x) => x.tabId === focusedRef.current);
        return t ? { tabId: t.tabId, appId: t.appId } : null;
      },
      tabs: () => tabsRef.current,
      apps: () => appsRef.current,
      refocus: refocusForRestore,
      rebuildAppInPlace: (tabId, appId) =>
        rebuildTabApp(tabId, appId, undefined, { mirror: false }),
      mintForRestore: (appId) => {
        const tab: Tab = {
          tabId: crypto.randomUUID(),
          appId,
          store: makeBackgroundStore(appId, appsRef.current),
        };
        const nextTabs = [...tabsRef.current, tab];
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        activateWithoutMirror(tab);
        setFocusedTabId(tab.tabId);
      },
      restoreLiveRoute: () => {
        const t = tabsRef.current.find((x) => x.tabId === focusedRef.current);
        t?.store.handleLocationChange();
      },
      setFocusedApp,
      persist,
    });
    adapterRef.current = adapter;
    const uninstallAdapter = setHistoryAdapter(adapter);
    const focused = tabsRef.current.find((t) => t.tabId === focusedRef.current);
    if (focused) {
      // `currentRoutePath()`, never the raw pathname: this replace-stamp is the
      // FIRST history write of the session, and a raw `//agents/c/x` would
      // resolve scheme-relative (`http://agents/c/x`) and throw SecurityError,
      // bricking boot. The canonical form also re-writes the address bar in
      // place, so a slash-mangled deep link self-heals into a working one.
      adapter.commit({
        url: currentRoutePath(),
        state: serializePaneState(focused.store.getRouteState()),
        mode: "replace",
      });
    }
    return uninstallAdapter;
  }, [refocusForRestore, rebuildTabApp, activateWithoutMirror, persist]);

  const api = useMemo<TabsApi>(
    () => ({
      tabs,
      focusedTabId,
      titles,
      mode,
      setMode,
      exitToPreviousMode,
      setTabTitle,
      openTab,
      replaceTabApp,
      navigate,
      focusTab,
      closeTab,
      moveTab,
    }),
    [
      tabs,
      focusedTabId,
      titles,
      mode,
      setMode,
      exitToPreviousMode,
      setTabTitle,
      openTab,
      replaceTabApp,
      navigate,
      focusTab,
      closeTab,
      moveTab,
    ],
  );

  // Publish the surface mode + bound setters at module scope so out-of-provider
  // callers (floating-bar mode control, Esc shortcut, pin guard) can read and
  // drive it. Mirrors the `setTabsNavigator` handle above.
  useEffect(() => {
    publishSurfaceMode(mode, setMode, exitToPreviousMode);
    return () => publishSurfaceMode(peekDefaultPlacement(), null, null);
  }, [mode, setMode, exitToPreviousMode]);

  return <TabsContext.Provider value={api}>{children}</TabsContext.Provider>;
}
