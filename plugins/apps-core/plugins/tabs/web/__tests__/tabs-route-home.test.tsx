import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Apps, setFocusedApp } from "@plugins/apps-core/web";
import {
  Pane,
  setLiveStore,
  useSyncPaneRegistry,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { defaultStore } from "@plugins/primitives/plugins/pane/web/testing";
import { TabsProvider, useTabs, type TabsApi } from "../internal/use-tabs";

// A ROUTE ARRIVING BY URL LANDS IN ITS ROOT PANE'S APP.
//
// The opener hands a route headed by another app's pane to that app; a URL
// skips the opener. `/pages/s/1` names a Story pane under Pages — the Story
// surface stranded in Pages — so the tab manager moves the focused tab to
// Story, rewriting the entry in place (Back must not return to the stranded
// one).

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

const storyPane = Pane.define({
  route: defineRoute({ id: "route-home-story", segment: "s/:id" }),
  app: storyApp,
  useResolve: false,
  component: () => null,
});

const plugin = {
  id: "tabs-route-home-test",
  description: "fake apps + a Story pane for the route-home suite",
  contributions: [
    Apps.App({ app: pagesApp, component: () => null, icon: {} as never }),
    Apps.App({ app: storyApp, component: () => null, icon: {} as never }),
    Pane.Register({ pane: storyPane }),
  ],
} as unknown as LoadedPlugin;

const composition = { id: "test", home: "pages" };

// The apps root syncs the registry before the tab set boots; so does this.
function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

let hook!: { current: TabsApi };
async function mount() {
  const { result } = renderHook(() => useTabs(), {
    wrapper: ({ children }) => (
      <PluginProvider plugins={[plugin]} composition={composition}>
        <RegistrySync />
        <TabsProvider>{children}</TabsProvider>
      </PluginProvider>
    ),
  });
  hook = result;
  // The move runs from an effect and a microtask after it.
  await act(async () => {});
}

const focusedApp = () =>
  hook.current.tabs.find((t) => t.tabId === hook.current.focusedTabId)?.appId;

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
});

afterEach(() => {
  cleanup();
  setFocusedApp(undefined);
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("a URL whose route belongs to another app", () => {
  it("at boot, moves the focused tab to that app and rewrites the entry", async () => {
    window.history.replaceState(null, "", "/pages/s/1");
    const pushSpy = vi.spyOn(window.history, "pushState");

    await mount();

    expect(focusedApp()).toBe("story");
    expect(window.location.pathname).toBe("/story/s/1");
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("through navigate(), lands in that app too", async () => {
    window.history.replaceState(null, "", "/pages");
    await mount();
    expect(focusedApp()).toBe("pages");

    await act(async () => {
      hook.current.navigate("/pages/s/2");
    });

    expect(focusedApp()).toBe("story");
    expect(window.location.pathname).toBe("/story/s/2");
  });

  it("leaves a route of the URL's own app where it is", async () => {
    window.history.replaceState(null, "", "/story/s/3");
    await mount();
    expect(focusedApp()).toBe("story");
    expect(window.location.pathname).toBe("/story/s/3");
  });
});
