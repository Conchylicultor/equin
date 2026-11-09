import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Apps, setFocusedApp } from "@plugins/apps-core/web";
import {
  AppNavBoundary,
  setLiveStore,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { defaultStore } from "@plugins/primitives/plugins/pane/web/testing";
import { runActivation } from "@plugins/primitives/plugins/link-gesture/core";
import { TabsProvider, getSurfaceMode, useTabs } from "../internal/use-tabs";
import { useActivateApp } from "../internal/use-activate-app";
import { pagePlacementRegistry } from "../internal/placement-registry";
import { symbol } from "@plugins/ui/plugins/icons/core";

// AN APP PICK INSIDE AN EMBED IS THE EMBED'S.
//
// The launcher drawn inside an `<AppEmbed>` activates apps through
// `useActivateApp`. A tab app's pick goes to the embed's `AppNavBoundary`; a
// surface-mode app (the desktop) switches the mode of the tab set the
// launcher is in — the embed's own — never the host's tabs or surface mode.

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
  icon: symbol("home"),
});
const storyApp = defineApp({
  id: "story",
  name: "Story",
  basePath: "/story",
  icon: symbol("home"),
});
const deskApp = defineApp({
  id: "desk",
  name: "Desk",
  basePath: "/desk",
  icon: symbol("home"),
});

const plugin = {
  id: "tabs-activate-boundary-test",
  description: "fake apps for the activate-app boundary suite",
  contributions: [
    Apps.App({ app: pagesApp, component: () => null }),
    Apps.App({ app: storyApp, component: () => null }),
    Apps.App({ app: deskApp, surfaceMode: "desktop" }),
  ],
} as unknown as LoadedPlugin;

const composition = { id: "test", home: "pages" };

function useHarness() {
  return { tabs: useTabs(), activate: useActivateApp() };
}

/** The harness inside an embedded tab set, itself inside the page's. */
async function mountEmbedded(onLeave: (url: string) => void) {
  const rendered = renderHook(() => useHarness(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <PluginProvider plugins={[plugin]} composition={composition}>
        <TabsProvider>
          <TabsProvider
            embedded={{
              at: { app: "pages", route: "/" },
              onLeave,
              fillsPage: false,
            }}
          >
            {children}
          </TabsProvider>
        </TabsProvider>
      </PluginProvider>
    ),
  });
  await act(async () => {});
  return rendered.result;
}

async function mount(boundary: ((url: string) => void) | null) {
  const rendered = renderHook(() => useHarness(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <PluginProvider plugins={[plugin]} composition={composition}>
        <TabsProvider>
          {boundary ? (
            <AppNavBoundary navigator={boundary}>{children}</AppNavBoundary>
          ) : (
            children
          )}
        </TabsProvider>
      </PluginProvider>
    ),
  });
  await act(async () => {});
  return rendered.result;
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
  uninstallPlacements = pagePlacementRegistry.install({
    defaultId: "docked",
    ids: new Set(["docked", "desktop"]),
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

function shape(hook: { current: ReturnType<typeof useHarness> }) {
  return hook.current.tabs.tabs.map((t) => t.appId);
}

describe("useActivateApp inside an AppNavBoundary", () => {
  it("a surface-mode app switches the embed's own mode; the host's surface mode and URL stay", async () => {
    const left: string[] = [];
    const hook = await mountEmbedded((url) => left.push(url));
    const modeBefore = getSurfaceMode();
    expect(hook.current.tabs.contained).toBe(true);

    await act(async () => {
      runActivation(
        hook.current.activate({
          id: "desk",
          app: deskApp,
          surfaceMode: "desktop",
        }),
      );
    });

    expect(hook.current.tabs.mode).toBe("desktop");
    expect(left).toEqual([]);
    expect(getSurfaceMode()).toBe(modeBefore);
    expect(window.location.pathname).toBe("/pages");
  });

  it("a tab app moves the embedded tab set; the host's URL stays", async () => {
    const hook = await mountEmbedded(() => {});
    expect(shape(hook)).toEqual(["pages"]);

    await act(async () => {
      runActivation(
        hook.current.activate({
          id: "story",
          app: storyApp,
          surfaceMode: undefined,
        }),
      );
    });

    expect(shape(hook)).toEqual(["story"]);
    expect(window.location.pathname).toBe("/pages");
  });

  it("a tab app goes to the boundary; the host's tab is not swapped", async () => {
    const bounded: string[] = [];
    const hook = await mount((url) => bounded.push(url));
    const tabsBefore = shape(hook);

    await act(async () => {
      runActivation(
        hook.current.activate({
          id: "story",
          app: storyApp,
          surfaceMode: undefined,
        }),
      );
    });

    expect(bounded).toEqual(["/story"]);
    expect(shape(hook)).toEqual(tabsBefore);
    expect(window.location.pathname).toBe("/pages");
  });
});

describe("useActivateApp outside any boundary", () => {
  it("a tab app swaps the focused tab", async () => {
    const hook = await mount(null);
    expect(shape(hook)).toEqual(["pages"]);

    await act(async () => {
      runActivation(
        hook.current.activate({
          id: "story",
          app: storyApp,
          surfaceMode: undefined,
        }),
      );
    });

    expect(shape(hook)).toEqual(["story"]);
    expect(window.location.pathname).toBe("/story");
  });
});
