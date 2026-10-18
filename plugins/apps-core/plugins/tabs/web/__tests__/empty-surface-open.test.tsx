import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Apps, setFocusedApp } from "@plugins/apps-core/web";
import {
  Pane,
  openPane,
  setLiveStore,
  useOpenPane,
  useSyncPaneRegistry,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { defaultStore } from "@plugins/primitives/plugins/pane/web/testing";
import { TabsProvider, useTabs } from "../internal/use-tabs";
import { registerPlacementCapabilities } from "../internal/placement-registry";

// OPENING A PANE ON AN EMPTY SURFACE OPENS A TAB.
//
// The desktop can hold no window. Global chrome (the floating action bar and
// its popovers) opens panes through the live store, which on an empty surface
// used to be the closed tab's dead store — the click did nothing. The live
// store is now the empty-surface store, and its first route becomes a new
// focused tab on the home app.

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

const pagesApp = defineApp({
  id: "pages",
  name: "Pages",
  basePath: "/pages",
  iconKey: "home",
});
const storyApp = defineApp({
  id: "story",
  name: "Story",
  basePath: "/story",
  iconKey: "home",
});

// Homed in the composition's home app.
const guestPane = Pane.define({
  route: defineRoute({ id: "empty-surface-guest", segment: "guest" }),
  app: pagesApp,
  component: () => null,
});

const storyPane = Pane.define({
  route: defineRoute({ id: "empty-surface-story", segment: "s/:id" }),
  app: storyApp,
  useResolve: false,
  component: () => null,
});

const plugin = {
  id: "tabs-empty-surface-test",
  description: "fake apps + panes for the empty-surface open suite",
  contributions: [
    Apps.App({ app: pagesApp, component: () => null, icon: {} as never }),
    Apps.App({ app: storyApp, component: () => null, icon: {} as never }),
    Pane.Register({ pane: guestPane }),
    Pane.Register({ pane: storyPane }),
  ],
} as unknown as LoadedPlugin;

const composition = { id: "test", home: "pages" };

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

// Rendered beside the tab set, outside every pane surface — global chrome.
function useHarness() {
  return { tabs: useTabs(), open: useOpenPane() };
}

let hook!: { current: ReturnType<typeof useHarness> };
let unmount!: () => void;
async function mount() {
  const rendered = renderHook(() => useHarness(), {
    wrapper: ({ children }) => (
      <PluginProvider plugins={[plugin]} composition={composition}>
        <RegistrySync />
        <TabsProvider>{children}</TabsProvider>
      </PluginProvider>
    ),
  });
  hook = rendered.result;
  unmount = rendered.unmount;
  await act(async () => {});
}

async function closeEveryTab() {
  for (const t of [...hook.current.tabs.tabs]) {
    await act(async () => {
      hook.current.tabs.closeTab(t.tabId);
    });
  }
  expect(hook.current.tabs.tabs).toHaveLength(0);
  expect(window.location.pathname).toBe("/");
}

function focused() {
  const { tabs, focusedTabId } = hook.current.tabs;
  return tabs.find((t) => t.tabId === focusedTabId);
}

let uninstallPlacements: () => void;

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
  setFocusedApp(undefined);
  window.history.replaceState(null, "", "/pages");
  uninstallPlacements = registerPlacementCapabilities({
    defaultId: "desktop",
    ids: new Set(["desktop"]),
    newTabFollows: new Set(["desktop"]),
    appThemeScope: new Set(),
    ownsChrome: new Set(["desktop"]),
    allowsEmpty: new Set(["desktop"]),
  });
});

afterEach(() => {
  cleanup();
  uninstallPlacements();
  setFocusedApp(undefined);
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("opening a pane on an empty surface", () => {
  it("through the imperative openPane, opens a tab on the home app", async () => {
    await mount();
    await closeEveryTab();
    const pushSpy = vi.spyOn(window.history, "pushState");

    await act(async () => {
      openPane(guestPane, {}, { mode: "root" });
    });

    expect(hook.current.tabs.tabs).toHaveLength(1);
    expect(focused()?.appId).toBe("pages");
    expect(
      focused()
        ?.store.getRoute()
        .map((s) => s.paneId),
    ).toEqual([guestPane._internal.id]);
    expect(window.location.pathname).toBe("/pages/guest");
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("through useOpenPane outside every surface, opens a tab too", async () => {
    await mount();
    await closeEveryTab();

    await act(async () => {
      hook.current.open(guestPane, {}, { mode: "push" });
    });

    expect(hook.current.tabs.tabs).toHaveLength(1);
    expect(window.location.pathname).toBe("/pages/guest");
  });

  it("opens a pane of the app whose last window just closed", async () => {
    // The closed tab's store is based at that app, so an open of its own pane
    // used to land there — in a store nothing renders.
    window.history.replaceState(null, "", "/story");
    await mount();
    expect(focused()?.appId).toBe("story");
    await closeEveryTab();

    await act(async () => {
      hook.current.open(storyPane, { id: "1" }, { mode: "push" });
    });

    expect(hook.current.tabs.tabs).toHaveLength(1);
    expect(focused()?.appId).toBe("story");
    expect(window.location.pathname).toBe("/story/s/1");
  });

  it("opens a pane homed in another app in that app", async () => {
    await mount();
    await closeEveryTab();

    await act(async () => {
      hook.current.open(storyPane, { id: "1" }, { mode: "push" });
    });

    expect(hook.current.tabs.tabs).toHaveLength(1);
    expect(focused()?.appId).toBe("story");
    expect(window.location.pathname).toBe("/story/s/1");
  });

  it("after a reload into the empty surface", async () => {
    await mount();
    await closeEveryTab();
    unmount();

    await mount();
    expect(hook.current.tabs.tabs).toHaveLength(0);

    await act(async () => {
      openPane(guestPane, {}, { mode: "root" });
    });

    expect(hook.current.tabs.tabs).toHaveLength(1);
    expect(window.location.pathname).toBe("/pages/guest");
  });

  it("once a link opened a tab, a later open lands in that tab", async () => {
    await mount();
    await closeEveryTab();

    await act(async () => {
      hook.current.tabs.navigate("/pages");
    });
    const tabId = hook.current.tabs.focusedTabId;
    await act(async () => {
      openPane(guestPane, {}, { mode: "root" });
    });

    expect(hook.current.tabs.tabs).toHaveLength(1);
    expect(hook.current.tabs.focusedTabId).toBe(tabId);
    expect(window.location.pathname).toBe("/pages/guest");
  });
});
