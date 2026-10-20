import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  markDeferredLoadComplete,
  markDeferredPluginsFailed,
} from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import {
  appInstanceId,
  getAppInstanceId,
  getNavigationType,
} from "@plugins/primitives/plugins/scope/plugins/app-instance/web";
import { resetAppInstanceForTests } from "@plugins/primitives/plugins/scope/plugins/app-instance/web/testing";
import { bootTabs } from "../internal/use-tabs";
import { isDeadUnresolvedLink } from "../internal/load-scope";
import type { PersistedTabs } from "../internal/tabs-store";

// bootTabs is nearly pure store construction: it reads the address bar + the
// persisted-tabs blob and returns the initial tab set, seeding the focused tab's
// route via the tri-state parse. The pane registry is empty in this file (no
// renderer runs `useSyncPaneRegistry`), so any non-bare deep link parses as
// `unresolved` — exactly the cold-boot "deferred plugin not loaded yet" case the
// four-branch logic exists for.

// bootTabs only reads each contribution's `.id`, its `AppRef`'s `.basePath`
// (the app is handed to `Apps.App` whole, so the base path lives on `.app`)
// and whether it is a tab app (`component`); cast a plain fixture to the
// sealed contribution list type.
type AppList = Parameters<typeof bootTabs>[0];
const fakeApp = (id: string, basePath: string) => ({
  id,
  app: { id, name: id, basePath },
  component: () => null,
});
const APPS = [fakeApp("pages", "/pages")] as unknown as AppList;

/** Minimal in-memory Storage — jsdom's sessionStorage under vitest is inert. */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  key(i: number) {
    return [...this.store.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v));
  }
}

const realLocation = window.location;

function setPath(pathname: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { pathname },
  });
}

/** Write the persisted-tabs entry under the CURRENT app instance's id. */
function persist(payload: PersistedTabs): void {
  window.sessionStorage.setItem(
    `s:apps-core.tabs:${appInstanceId()}`,
    JSON.stringify({ v: payload, ts: Date.now() }),
  );
}

// The primitive's own reading of the entry's `type`.
type NavigationType = NonNullable<ReturnType<typeof getNavigationType>>;

/**
 * Stub `PerformanceNavigationTiming.type` — the one signal that decides fresh
 * vs. preserve. jsdom reports NO navigation entry, which the primitive treats
 * as `reload`; that is why every pre-existing case below still restores.
 */
function navType(type: NavigationType): void {
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([
    { type } as unknown as PerformanceEntry,
  ]);
}

/** The focused tab's route state after a boot (reads `window.location`). */
function focusedState() {
  const boot = bootTabs(APPS, "pages");
  const focused = boot.tabs.find((t) => t.tabId === boot.focusedTabId)!;
  return focused.store.getRouteState();
}

beforeEach(() => {
  const mem = new MemoryStorage();
  Object.defineProperty(window, "sessionStorage", {
    value: mem,
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: mem,
    configurable: true,
  });
  // Storage first, then drop the memoized instance: the resolver mints/adopts
  // against sessionStorage on its next call, which must be this fresh one.
  resetAppInstanceForTests();
  window.history.replaceState(null, "", "/");
  resetDeferredLoadStateForTests();
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  resetDeferredLoadStateForTests();
});

describe("bootTabs — tri-state focused-tab seeding", () => {
  it("instant-restore: persisted route + rawPath === the URL ⇒ restores the persisted slots, not pending", () => {
    persist({
      tabs: [
        {
          tabId: "t1",
          appId: "pages",
          route: [
            { paneId: "page", params: { id: "abc" }, options: {}, uuid: "u1" },
          ],
          rawPath: "page/abc",
        },
      ],
      focusedTabId: "t1",
      mode: "",
    });
    setPath("/pages/page/abc");

    const state = focusedState();
    expect(state.kind).toBe("resolved");
    // restoreRoute (branch 3), NOT clearRoute and NOT seedPending.
    expect(
      state.kind === "resolved" ? state.slots.map((s) => s.paneId) : null,
    ).toEqual(["page"]);
    // The same pane instance comes back: it keeps its uuid.
    expect(
      state.kind === "resolved" ? state.slots.map((s) => s.uuid) : null,
    ).toEqual(["u1"]);
  });

  it("different deep link: persisted rawPath ≠ the URL ⇒ seeds a pending route", () => {
    persist({
      tabs: [
        {
          tabId: "t1",
          appId: "pages",
          route: [
            {
              paneId: "page",
              params: { id: "other" },
              options: {},
              uuid: "u1",
            },
          ],
          rawPath: "page/other",
        },
      ],
      focusedTabId: "t1",
      mode: "",
    });
    setPath("/pages/page/abc");

    const state = focusedState();
    expect(state.kind).toBe("unresolved");
    expect(state.kind === "unresolved" ? state.rawPath : null).toBe("page/abc");
  });

  it("bare app root (matched, empty) ⇒ clears to the resolved-empty index route", () => {
    persist({
      tabs: [{ tabId: "t1", appId: "pages", route: [], rawPath: "" }],
      focusedTabId: "t1",
      mode: "",
    });
    setPath("/pages");

    const state = focusedState();
    expect(state.kind).toBe("resolved");
    expect(state.kind === "resolved" ? state.slots.length : -1).toBe(0);
  });
});

describe("bootTabs — snapshot-stable focus across reload", () => {
  // The shell-history-snapshot model relies on a stamped `history.state.tabId`
  // still matching an open tab after a reload. bootTabs rebuilds tabs with their
  // PERSISTED ids, so the focused tab keeps its id when the URL's app matches —
  // this is what makes back/forward keep working across reloads.
  const APPS2 = [
    fakeApp("pages", "/pages"),
    fakeApp("story", "/story"),
  ] as unknown as AppList;

  it("reuses the persisted focused tabId when the URL's app matches (no phantom mint)", () => {
    persist({
      tabs: [{ tabId: "t1", appId: "pages", route: [], rawPath: "" }],
      focusedTabId: "t1",
      mode: "",
    });
    setPath("/pages");

    const boot = bootTabs(APPS2, "pages");
    expect(boot.focusedTabId).toBe("t1");
    expect(boot.tabs.map((t) => t.tabId)).toEqual(["t1"]);
  });

  it("keeps other apps' tabs alive and mints a fresh focused tab for a genuine cross-app deep-link", () => {
    persist({
      tabs: [{ tabId: "t-story", appId: "story", route: [], rawPath: "" }],
      focusedTabId: "t-story",
      mode: "",
    });
    setPath("/pages");

    const boot = bootTabs(APPS2, "pages");
    // The story tab survives (keep-alive), and a fresh pages tab is focused —
    // the genuine deep-link fallback, not a desync-driven phantom.
    expect(boot.tabs.some((t) => t.tabId === "t-story")).toBe(true);
    const focused = boot.tabs.find((t) => t.tabId === boot.focusedTabId)!;
    expect(focused.appId).toBe("pages");
    expect(boot.focusedTabId).not.toBe("t-story");
  });
});

describe("bootTabs — app instances (fresh state vs. preserved state)", () => {
  const APPS2 = [
    fakeApp("pages", "/pages"),
    fakeApp("story", "/story"),
  ] as unknown as AppList;

  it("navigate (bookmark / address bar): seeds exactly ONE tab from the URL, at the default mode", () => {
    // A fully-populated previous instance: two tabs across two apps, focused on
    // story, in a non-default surface mode.
    persist({
      tabs: [
        { tabId: "t-pages", appId: "pages", route: [], rawPath: "" },
        { tabId: "t-story", appId: "story", route: [], rawPath: "" },
      ],
      focusedTabId: "t-story",
      mode: "floating",
    });

    // The bookmark click: a cross-document navigation, so a NEW instance whose
    // storage key names an empty slot. (Dropping the memo makes the next
    // resolve read the stubbed nav type, as a real cold boot would.)
    navType("navigate");
    resetAppInstanceForTests();
    setPath("/pages");

    const boot = bootTabs(APPS2, "pages");
    // The reported bug, at unit level: this used to be the story tab PLUS a
    // freshly-minted pages tab.
    expect(boot.tabs.length).toBe(1);
    expect(boot.tabs[0]!.appId).toBe("pages");
    expect(boot.focusedTabId).toBe(boot.tabs[0]!.tabId);
    expect(boot.tabs.map((t) => t.tabId)).not.toContain("t-story");
    // Surface mode is instance state, so it resets with the instance. `""` is
    // the unresolved seed: boot no longer samples the placement registry (a
    // render-path read), and TabsProvider resolves "" to the registered
    // default on every render.
    expect(boot.mode).toBe("");
    expect(boot.mode).not.toBe("floating");
  });

  it("back_forward: the entry's own tabId wins over the persisted focusedTabId", () => {
    const gen = getAppInstanceId();
    persist({
      tabs: [
        { tabId: "t1", appId: "pages", route: [], rawPath: "" },
        { tabId: "t2", appId: "pages", route: [], rawPath: "" },
      ],
      focusedTabId: "t1",
      mode: "",
    });
    // The entry the browser restored names t2 — and names the instance that
    // wrote it, so this boot adopts that instance rather than minting one.
    window.history.replaceState(
      { tabId: "t2", appId: "pages", appInstance: gen, route: [] },
      "",
      "/pages",
    );
    navType("back_forward");
    resetAppInstanceForTests();
    setPath("/pages");

    const boot = bootTabs(APPS2, "pages");
    expect(boot.tabs.map((t) => t.tabId)).toEqual(["t1", "t2"]);
    // A history entry is a complete snapshot: it beats the persisted focus.
    expect(boot.focusedTabId).toBe("t2");
  });

  it("evicted generation: mints ONE tab reusing the entry's seed tabId", () => {
    // Nothing persisted under the adopted generation — the instance the entry
    // named has aged out of the retained set. The seed id is passed directly
    // (the parameter exists for exactly this): whichever generation the boot
    // lands in, the entry's own tabId is what the minted tab must carry.
    setPath("/pages");

    const boot = bootTabs(APPS2, "pages", "t-gone");
    expect(boot.tabs.length).toBe(1);
    // Reusing the entry's id keeps the surrounding entries recognisable to the
    // shell adapter's restore(), instead of minting a stranger.
    expect(boot.focusedTabId).toBe("t-gone");
  });
});

describe("isDeadUnresolvedLink — the navigate() dead-link gate", () => {
  const PREFIX = "apps/plugins/pages/";

  it("while the deferred tier is loading ⇒ not dead (navigate seeds pending)", () => {
    expect(isDeadUnresolvedLink(PREFIX)).toBe(false);
  });

  it("settled + healthy ⇒ dead link (navigate throws)", () => {
    markDeferredLoadComplete();
    expect(isDeadUnresolvedLink(PREFIX)).toBe(true);
  });

  it("settled + a load error under this app's subtree ⇒ not dead (app broken, seeds pending)", () => {
    markDeferredLoadComplete();
    markDeferredPluginsFailed(["apps/plugins/pages/plugins/page-tree"]);
    expect(isDeadUnresolvedLink(PREFIX)).toBe(false);
  });
});
