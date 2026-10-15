import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Apps, setFocusedApp } from "@plugins/apps-core/web";
import { getFocusedAppId } from "@plugins/apps-core/web/testing";
import { setLiveStore } from "@plugins/primitives/plugins/pane/web";
import { defaultStore } from "@plugins/primitives/plugins/pane/web/testing";
import { TabsProvider, useTabs, type TabsApi } from "../internal/use-tabs";

// End-to-end proof of the shell-history-snapshot model at the TabsProvider
// level: every user-initiated change to what's on screen PUSHES a composite
// { tabId, appId, route } snapshot (cross-app navigate, openTab, focusTab),
// corrections REPLACE (boot stamp, close-tab neighbor refocus), and a real
// browser back/forward (popstate) restores the whole snapshot — refocusing a
// tab, rebuilding an app in place, or applying to the focused tab — with ZERO
// history writes and no phantom-tab mint. Chrome identity (`focusedApp`) tracks
// the focused tab throughout.
//
// Bare-root apps only: an empty route needs no pane registry, so the suite
// stays boundary-clean while still exercising the full push/replace + restore
// machinery. The route-shape serialization is covered by the adapter unit suite.

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

// Two fake bare-root apps (pages is the composition's home). `icon` is never rendered here,
// so a `never` cast keeps the fixture honest without a real AppIcon.
const appsPlugin = {
  id: "tabs-history-test-apps",
  description: "fake apps for the tabs-history suite",
  contributions: [
    Apps.App({
      app: { id: "pages", name: "Pages", basePath: "/pages", iconKey: "home" },
      component: () => null,
      icon: {} as never,
    }),
    Apps.App({
      app: { id: "story", name: "Story", basePath: "/story", iconKey: "home" },
      component: () => null,
      icon: {} as never,
    }),
  ],
} as unknown as LoadedPlugin;

// The deployed composition's home — what a bare `/` and a last-closed tab seed.
const composition = { id: "test", home: "pages" };

// Latest TabsApi via renderHook's live `result` ref, so post-`act` reads see
// fresh state without reassigning module state during render.
let hook!: { current: TabsApi };
function mount() {
  const { result } = renderHook(() => useTabs(), {
    wrapper: ({ children }) => (
      <PluginProvider plugins={[appsPlugin]} composition={composition}>
        <TabsProvider>{children}</TabsProvider>
      </PluginProvider>
    ),
  });
  hook = result;
}

/** History.state read as the composite snapshot the shell writes. */
function snapshot() {
  return (window.history.state ?? {}) as {
    tabId?: string;
    appId?: string;
    route?: unknown;
    pending?: unknown;
  };
}

/** Simulate a real browser back/forward onto `state` at `url`, then popstate. */
function goBackTo(state: unknown, url: string) {
  // The browser advances URL + history.state BEFORE firing popstate; model that
  // outside `act` so it is never counted as a write the code under test made.
  window.history.replaceState(state, "", url);
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
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
  window.history.replaceState(null, "", "/pages");
  setFocusedApp(undefined);
});

afterEach(() => {
  cleanup(); // unmount → TabsProvider teardown restores the default adapter
  setFocusedApp(undefined);
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("boot", () => {
  it("replace-stamps the composite { tabId, appId } without adding an entry", () => {
    const pushSpy = vi.spyOn(window.history, "pushState");
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    mount();

    // The boot stamp is a REPLACE, never a push — no new Back target on mount.
    expect(pushSpy).not.toHaveBeenCalled();
    expect(replaceSpy).toHaveBeenCalled();
    const s = snapshot();
    expect(s.appId).toBe("pages");
    expect(s.tabId).toBe(hook.current.focusedTabId);
    expect(getFocusedAppId()).toBe("pages");
  });
});

describe("push/replace matrix", () => {
  it("cross-app navigate() PUSHES a composite { tabId, appId, route } (was replace)", () => {
    mount();
    const focusedBefore = hook.current.focusedTabId;
    const pushSpy = vi.spyOn(window.history, "pushState");

    act(() => {
      hook.current.navigate("/story");
    });

    expect(pushSpy).toHaveBeenCalled();
    const s = snapshot();
    expect(s.appId).toBe("story");
    // Same tab, rebuilt in place to the story app (tabId preserved).
    expect(s.tabId).toBe(focusedBefore);
    expect(s.tabId).toBe(hook.current.focusedTabId);
    expect(s.route).toEqual([]);
    expect(getFocusedAppId()).toBe("story");
  });

  it("openTab PUSHES and stamps the NEWLY focused tab (focused ref set before mirror)", () => {
    mount();
    const pushSpy = vi.spyOn(window.history, "pushState");

    let newId!: string;
    act(() => {
      newId = hook.current.openTab("story");
    });

    expect(pushSpy).toHaveBeenCalled();
    expect(hook.current.focusedTabId).toBe(newId);
    expect(hook.current.tabs.length).toBe(2);
    const s = snapshot();
    expect(s.tabId).toBe(newId);
    expect(s.appId).toBe("story");
    expect(getFocusedAppId()).toBe("story");
  });

  it("focusTab PUSHES and stamps the refocused tab", () => {
    mount();
    const pagesTab = hook.current.focusedTabId;
    let storyId!: string;
    act(() => {
      storyId = hook.current.openTab("story");
    });
    expect(hook.current.focusedTabId).toBe(storyId);

    const pushSpy = vi.spyOn(window.history, "pushState");
    act(() => {
      hook.current.focusTab(pagesTab);
    });

    expect(pushSpy).toHaveBeenCalled();
    expect(hook.current.focusedTabId).toBe(pagesTab);
    const s = snapshot();
    expect(s.tabId).toBe(pagesTab);
    expect(s.appId).toBe("pages");
    expect(getFocusedAppId()).toBe("pages");
  });

  it("closeTab neighbor refocus REPLACES (top entry points at the destroyed tab)", () => {
    mount();
    const pagesTab = hook.current.focusedTabId;
    let storyId!: string;
    act(() => {
      storyId = hook.current.openTab("story");
    });
    expect(hook.current.focusedTabId).toBe(storyId);

    const pushSpy = vi.spyOn(window.history, "pushState");
    const replaceSpy = vi.spyOn(window.history, "replaceState");
    act(() => {
      hook.current.closeTab(storyId);
    });

    expect(replaceSpy).toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(hook.current.focusedTabId).toBe(pagesTab);
    expect(hook.current.tabs.length).toBe(1);
    expect(snapshot().tabId).toBe(pagesTab);
    expect(snapshot().appId).toBe("pages");
  });
});

describe("restore (real browser back/forward)", () => {
  it("refocuses another open tab: live flags flip, focus + focusedApp updated, nothing minted", () => {
    mount();
    const pagesTab = hook.current.focusedTabId;
    const pagesEntry = window.history.state; // the boot-stamped pages snapshot

    let storyId!: string;
    act(() => {
      storyId = hook.current.openTab("story");
    });
    expect(hook.current.focusedTabId).toBe(storyId);

    goBackTo(pagesEntry, "/pages");

    expect(hook.current.focusedTabId).toBe(pagesTab);
    expect(hook.current.tabs.length).toBe(2); // no phantom mint
    const pages = hook.current.tabs.find((t) => t.tabId === pagesTab)!;
    const story = hook.current.tabs.find((t) => t.tabId === storyId)!;
    expect(pages.store.live).toBe(true);
    expect(story.store.live).toBe(false);
    expect(getFocusedAppId()).toBe("pages");
  });

  it("matching tabId + different app rebuilds the tab in place, with ZERO history writes (bug 2)", () => {
    mount();
    const tabId = hook.current.focusedTabId;

    act(() => {
      hook.current.navigate("/story");
    });
    const storyEntry = window.history.state; // { route:[], tabId, appId:"story" }
    act(() => {
      hook.current.navigate("/pages");
    });
    expect(hook.current.tabs.find((t) => t.tabId === tabId)!.appId).toBe(
      "pages",
    );

    // Model the browser restoring the story entry BEFORE spying, so only what
    // restore() itself does is measured.
    window.history.replaceState(storyEntry, "", "/story");
    const pushSpy = vi.spyOn(window.history, "pushState");
    const replaceSpy = vi.spyOn(window.history, "replaceState");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(hook.current.tabs.find((t) => t.tabId === tabId)!.appId).toBe(
      "story",
    );
    expect(hook.current.tabs.length).toBe(1);
    expect(getFocusedAppId()).toBe("story");
    // Restoration NEVER writes history — the browser already advanced it.
    expect(pushSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("closed-tab snapshot applies { appId } to the focused tab and mints NO tab", () => {
    mount();
    const pagesTab = hook.current.focusedTabId;
    let storyId!: string;
    act(() => {
      storyId = hook.current.openTab("story");
    });
    const storyEntry = window.history.state; // { tabId:storyId, appId:"story" }
    act(() => {
      hook.current.closeTab(storyId);
    });
    expect(hook.current.tabs.length).toBe(1);
    expect(hook.current.focusedTabId).toBe(pagesTab);

    goBackTo(storyEntry, "/story");

    // Applied to the focused (pages) tab in place; the dead story tab is NOT revived.
    expect(hook.current.tabs.length).toBe(1);
    expect(hook.current.tabs[0]!.tabId).toBe(pagesTab);
    expect(hook.current.tabs[0]!.appId).toBe("story");
    expect(getFocusedAppId()).toBe("story");
  });

  it("legacy { route }-only entry falls back to URL reparse and reconciles the app", () => {
    mount();
    goBackTo({ route: [] }, "/story");
    expect(hook.current.tabs[0]!.appId).toBe("story");
    expect(getFocusedAppId()).toBe("story");
  });

  it("legacy { pending }-only entry falls back to URL reparse", () => {
    mount();
    goBackTo({ pending: "s/1" }, "/story/s/1");
    expect(hook.current.tabs[0]!.appId).toBe("story");
    expect(getFocusedAppId()).toBe("story");
  });

  it("legacy {} entry falls back to URL reparse", () => {
    mount();
    goBackTo({}, "/story");
    expect(hook.current.tabs[0]!.appId).toBe("story");
    expect(getFocusedAppId()).toBe("story");
  });
});

describe("focused-app publication", () => {
  it("publishes the focused app id on focus + app changes", () => {
    mount();
    expect(getFocusedAppId()).toBe("pages");

    act(() => {
      hook.current.openTab("story");
    });
    expect(getFocusedAppId()).toBe("story");

    const pagesTab = hook.current.tabs[0]!.tabId;
    act(() => {
      hook.current.focusTab(pagesTab);
    });
    expect(getFocusedAppId()).toBe("pages");
  });
});
