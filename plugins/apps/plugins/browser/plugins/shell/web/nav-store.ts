import { useMemo } from "react";
import type { PageState } from "@plugins/apps/plugins/browser/plugins/engine/core";
import { defineScopedStore } from "@plugins/primitives/plugins/scope/plugins/scoped-store/web";
import { SAVED_TABS_ID, savedTabs } from "./internal/saved-tabs";
import { restoreState } from "./internal/saved-tabs-model";

/**
 * A navigation command the app asks of a tab's remote page. Recorded by the
 * chrome (omnibox, nav controls, start page …) and delivered over the tab's
 * engine socket by the viewport.
 */
export type BrowserNavCommand =
  | { kind: "navigate"; url: string }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "stop" };

/** The latest undelivered-or-delivered command of a tab; `seq` orders them. */
export interface BrowserNavRequest {
  seq: number;
  cmd: BrowserNavCommand;
}

/**
 * Per-surface browser tab state. Each tab is a page in the engine's Chromium,
 * addressed by `key`; the page's navigation history lives there, and the host
 * reports its state back (`report`). The store does no IO and no URL
 * normalization — callers pass fully-formed URLs (the omnibox owns
 * normalization). The tab set itself is the browser's, not the surface's: a
 * surface starts from the saved set, and `PersistBrowserTabs` keeps the two one.
 */
export interface BrowserTab {
  /** The tab's id: its remote page's `key`, the same in every surface. */
  id: string;
  /** The remote page's key on the engine host (a UUID; a popup's is the host's). */
  key: string;
  /** What the tab shows: the page's URL, or `""` for the start page. */
  url: string;
  /**
   * The remote page's URL — kept while the start page is shown over it
   * (`goHome`), so `back` returns to the page. `""` while no remote page exists.
   */
  pageUrl: string;
  /** Whether the host has a page for `key` (an `attach` was sent, or adopted popup). */
  remote: boolean;
  title: string;
  faviconUrl: string | null;
  loading: boolean;
  /** The remote page's own history, as last reported by the host. */
  canGoBack: boolean;
  canGoForward: boolean;
  /** The latest navigation command; delivered once `seq > sentSeq`. */
  request: BrowserNavRequest | null;
  /** The `seq` of the last request delivered to the host (or superseded by `attach`). */
  sentSeq: number;
}

/** The per-surface collection of tabs with one active. */
export type BrowserTabsState = {
  tabs: BrowserTab[];
  activeId: string;
  /** Monotonic request counter — deterministic per surface. */
  seq: number;
  /**
   * Keys of closed tabs whose remote page still has to be told to close
   * (delivered by the viewport, then dropped with `closeDelivered`).
   */
  pendingCloses: string[];
};

interface FreshTabOptions {
  url?: string;
  /** Adopt an existing host page (a popup the page opened). */
  key?: string;
}

/** A fresh tab pointed at `url` (default: the start page). */
function freshTab(opts: FreshTabOptions = {}): BrowserTab {
  const url = opts.url ?? "";
  const key = opts.key ?? crypto.randomUUID();
  return {
    id: key,
    key,
    url,
    pageUrl: url,
    remote: opts.key !== undefined,
    title: "",
    faviconUrl: null,
    loading: url !== "",
    canGoBack: false,
    canGoForward: false,
    request: null,
    sentSeq: 0,
  };
}

/** The saved tab set, or — the first time — one start-page tab. */
function initialState(): BrowserTabsState {
  const saved = savedTabs.read(SAVED_TABS_ID);
  if (saved.kind === "value") return restoreState(saved.value);
  const first = freshTab();
  return { tabs: [first], activeId: first.id, seq: 1, pendingCloses: [] };
}

/**
 * Per-surface store (each surface gets its own isolated instance, seeded from
 * the saved tab set). A factory, so the state is read at each mount.
 */
export const BrowserTabsStore =
  defineScopedStore<BrowserTabsState>(initialState);

type SetState = (fn: (s: BrowserTabsState) => BrowserTabsState) => void;

/** Patch one tab by id. */
function patchTab(
  setState: SetState,
  id: string | ((s: BrowserTabsState) => string),
  fn: (t: BrowserTab, s: BrowserTabsState) => BrowserTab,
): void {
  setState((s) => {
    const target = typeof id === "function" ? id(s) : id;
    return {
      ...s,
      tabs: s.tabs.map((t) => (t.id === target ? fn(t, s) : t)),
    };
  });
}

/** Record `cmd` as the active tab's latest request (bumping the surface seq). */
function request(
  setState: SetState,
  fn: (
    t: BrowserTab,
  ) => { cmd: BrowserNavCommand; patch?: Partial<BrowserTab> } | null,
): void {
  setState((s) => {
    let bumped = false;
    const tabs = s.tabs.map((t) => {
      if (t.id !== s.activeId) return t;
      const r = fn(t);
      if (!r) return t;
      bumped = true;
      return { ...t, ...r.patch, request: { seq: s.seq, cmd: r.cmd } };
    });
    return bumped ? { ...s, tabs, seq: s.seq + 1 } : s;
  });
}

/** The derived navigation API consumed by the chrome bars and webview. */
export interface BrowserNavApi {
  /** Active tab's URL; `""` => start page. Drives the omnibox, history recorder, bookmarks. */
  current: string;
  /** The page can go back — or the start page is shown over a page `back` returns to. */
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /**
   * Navigate the active tab's page to `url`; `""` = `goHome`. From the start
   * page, the tab's existing remote page navigates (it stays in its history).
   */
  navigate(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  /**
   * Show the start page. The remote page is KEPT (not closed): `back` returns
   * to it, and the start page needs no remote page of its own.
   */
  goHome(): void;
}

/**
 * Reads the active tab and returns the imperative navigation API. Must be
 * called inside `<BrowserTabsStore.Provider>`.
 */
export function useBrowserNav(): BrowserNavApi {
  const state = BrowserTabsStore.useStore();
  const store = BrowserTabsStore.useStoreApi();
  // By invariant the store always holds ≥1 tab.
  const active =
    state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0];
  if (!active) throw new Error("BrowserTabsStore holds no tab");

  const actions = useMemo(() => {
    const setState: SetState = (fn) => store.setState(fn);
    const goHome = () =>
      patchTab(
        setState,
        (s) => s.activeId,
        (t) => (t.url === "" ? t : { ...t, url: "", loading: false }),
      );
    // Commands for the page itself; meaningless while the start page shows.
    const pageCmd = (cmd: BrowserNavCommand) =>
      request(setState, (t) => (t.url === "" ? null : { cmd }));
    return {
      goHome,
      navigate: (url: string) => {
        if (url === "") {
          goHome();
          return;
        }
        request(setState, () => ({
          cmd: { kind: "navigate", url },
          patch: { url, pageUrl: url, loading: true },
        }));
      },
      back: () => {
        const s = store.getState();
        const t = s.tabs.find((x) => x.id === s.activeId);
        // The start page over a kept page: back reveals the page.
        if (t && t.url === "") {
          if (t.pageUrl !== "") {
            patchTab(setState, t.id, (x) => ({ ...x, url: x.pageUrl }));
          }
          return;
        }
        pageCmd({ kind: "back" });
      },
      forward: () => pageCmd({ kind: "forward" }),
      reload: () => pageCmd({ kind: "reload" }),
      stop: () => pageCmd({ kind: "stop" }),
    };
  }, [store]);

  const onStartPage = active.url === "";
  return {
    current: active.url,
    canGoBack: onStartPage ? active.pageUrl !== "" : active.canGoBack,
    canGoForward: onStartPage ? false : active.canGoForward,
    loading: active.loading,
    ...actions,
  };
}

/** A flattened view of one tab for the strip and the viewport. */
export interface BrowserTabSummary {
  id: string;
  /** `""` => start page. */
  url: string;
  /** The page's title as the host reports it (`""` until known). */
  title: string;
  faviconUrl: string | null;
  loading: boolean;
  active: boolean;
}

export interface BrowserOpenOptions {
  /** Open without selecting it. */
  background?: boolean;
  /** Adopt the host page with this key (a popup the page opened). */
  key?: string;
}

/** The tab-collection API consumed by the tab strip and the webview. */
export interface BrowserTabsApi {
  tabs: BrowserTabSummary[];
  activeId: string;
  /** Make `id` the active tab (no-op if already active). */
  select(id: string): void;
  /** Open a new tab (start page if no `url`). Becomes active unless `background`. */
  open(url?: string, opts?: BrowserOpenOptions): void;
  /**
   * Close `id`; selects a neighbor if it was active. Closing the last tab
   * resets to one fresh start-page tab. A tab with a remote page queues its key
   * on `pendingCloses`, which the viewport delivers to the host.
   */
  close(id: string): void;
}

/**
 * Reads the tab collection and returns the imperative tab API. Must be called
 * inside `<BrowserTabsStore.Provider>`.
 */
export function useBrowserTabs(): BrowserTabsApi {
  const state = BrowserTabsStore.useStore();
  const store = BrowserTabsStore.useStoreApi();

  const actions = useMemo(
    () => ({
      select: (id: string) =>
        store.setState((s) => (s.activeId === id ? s : { ...s, activeId: id })),
      open: (url = "", opts?: BrowserOpenOptions) =>
        store.setState((s) => {
          // A popup another surface already adopted (the tab sets are shared).
          if (
            opts?.key !== undefined &&
            s.tabs.some((t) => t.key === opts.key)
          ) {
            return opts.background ? s : { ...s, activeId: opts.key };
          }
          const tab = freshTab({ url, key: opts?.key });
          return {
            ...s,
            tabs: [...s.tabs, tab],
            activeId: opts?.background ? s.activeId : tab.id,
          };
        }),
      close: (id: string) =>
        store.setState((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          const closed = s.tabs[idx];
          if (!closed) return s;
          const pendingCloses = closed.remote
            ? [...s.pendingCloses, closed.key]
            : s.pendingCloses;
          const remaining = s.tabs.filter((t) => t.id !== id);
          if (remaining.length === 0) {
            const tab = freshTab();
            return { ...s, tabs: [tab], activeId: tab.id, pendingCloses };
          }
          let { activeId } = s;
          if (activeId === id) {
            // Select the neighbor that visually takes the closed tab's place.
            const neighbor = remaining[Math.min(idx, remaining.length - 1)];
            if (neighbor) activeId = neighbor.id;
          }
          return { ...s, tabs: remaining, activeId, pendingCloses };
        }),
    }),
    [store],
  );

  return {
    tabs: state.tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      faviconUrl: t.faviconUrl,
      loading: t.loading,
      active: t.id === state.activeId,
    })),
    activeId: state.activeId,
    ...actions,
  };
}

/**
 * The engine-facing half of the store, for the viewport that owns the tabs'
 * sockets: every tab whole (key, pending request), the closes to deliver, and
 * the write-backs.
 */
export interface BrowserRemoteApi {
  tabs: BrowserTab[];
  activeId: string;
  /** Keys of closed tabs' remote pages still to close on the host. */
  pendingCloses: string[];
  /**
   * The tab's socket sent `attach` carrying `url`. A tab without a remote page
   * gets one at that URL, so a pending `navigate` to that same URL is
   * superseded (marked sent); any other pending request stays to be sent.
   */
  markAttached(tabId: string, url: string): void;
  /** The request `seq` was delivered over the tab's socket. */
  markSent(tabId: string, seq: number): void;
  /** The host reported the tab's page state. */
  report(tabId: string, state: PageState): void;
  /** The host was told to close the page `key`. */
  closeDelivered(key: string): void;
}

/** Reads the whole tab state for the viewport. Must be called inside `<BrowserTabsStore.Provider>`. */
export function useBrowserRemote(): BrowserRemoteApi {
  const state = BrowserTabsStore.useStore();
  const store = BrowserTabsStore.useStoreApi();

  const actions = useMemo(() => {
    const setState: SetState = (fn) => store.setState(fn);
    return {
      markAttached: (tabId: string, url: string) =>
        patchTab(setState, tabId, (t) => {
          if (t.remote) return t;
          const r = t.request;
          const superseded =
            r !== null && r.cmd.kind === "navigate" && r.cmd.url === url;
          return {
            ...t,
            remote: true,
            sentSeq: superseded ? r.seq : t.sentSeq,
          };
        }),
      markSent: (tabId: string, seq: number) =>
        patchTab(setState, tabId, (t) =>
          t.sentSeq >= seq ? t : { ...t, sentSeq: seq },
        ),
      report: (tabId: string, page: PageState) =>
        patchTab(setState, tabId, (t) => ({
          ...t,
          // The start page shown over the page keeps showing; the page's URL
          // is still tracked for `back`.
          url: t.url === "" ? "" : page.url,
          pageUrl: page.url,
          title: page.title,
          faviconUrl: page.faviconUrl,
          loading: t.url === "" ? false : page.loading,
          canGoBack: page.canGoBack,
          canGoForward: page.canGoForward,
        })),
      closeDelivered: (key: string) =>
        setState((s) => ({
          ...s,
          pendingCloses: s.pendingCloses.filter((k) => k !== key),
        })),
    };
  }, [store]);

  return {
    tabs: state.tabs,
    activeId: state.activeId,
    pendingCloses: state.pendingCloses,
    ...actions,
  };
}
