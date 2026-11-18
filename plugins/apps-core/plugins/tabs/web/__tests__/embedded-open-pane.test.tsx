import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Apps, setFocusedApp } from "@plugins/apps-core/web";
import {
  Pane,
  setLiveStore,
  useOpenPane,
  useSyncPaneRegistry,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { defaultStore } from "@plugins/primitives/plugins/pane/web/testing";
import { TabsProvider, useTabs } from "../internal/use-tabs";
import { pagePlacementRegistry } from "../internal/placement-registry";
import { symbol } from "@plugins/ui/plugins/icons/core";

// AN OPEN MADE INSIDE AN EMBED, OUTSIDE EVERY PANE SURFACE, IS THE EMBED'S.
//
// A dialog raised inside an `<AppEmbed>` renders in the embed's render origin:
// inside its tab set, outside any of its pane surfaces. `useOpenPane` there
// used to fall back to the PAGE's live store — the route of the page around
// the embed — so an open of the page's own app's pane landed in the page
// (its URL moved), and a positional open computed against the page's route.
// The website's live demo hit the twin of this through the free `openPane`
// (report-1795037821-n9tglr): Sonata's create flow opened the demo's new song
// in the page, whose `navigate()` has no Sonata. The embedded set now provides
// its focused store to its subtree.

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

const pagesGuidePane = Pane.define({
  route: defineRoute({ id: "embedded-open-pages-guide", segment: "guide" }),
  app: pagesApp,
  component: () => null,
});
const storyChapterPane = Pane.define({
  route: defineRoute({ id: "embedded-open-story-chapter", segment: "c/:id" }),
  app: storyApp,
  useResolve: false,
  component: () => null,
});

const plugin = {
  id: "tabs-embedded-open-pane-test",
  description: "fake apps + panes for the embedded open suite",
  contributions: [
    Apps.App({ app: pagesApp, component: () => null }),
    Apps.App({ app: storyApp, component: () => null }),
    Pane.Register({ pane: pagesGuidePane }),
    Pane.Register({ pane: storyChapterPane }),
  ],
} as unknown as LoadedPlugin;

const composition = { id: "test", home: "pages" };

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

// Inside the embedded set, outside every pane surface — a raised dialog.
function useHarness() {
  return { tabs: useTabs(), open: useOpenPane() };
}

async function mountEmbedded() {
  const left: string[] = [];
  const rendered = renderHook(() => useHarness(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <PluginProvider plugins={[plugin]} composition={composition}>
        <RegistrySync />
        <TabsProvider>
          <TabsProvider
            embedded={{
              at: { app: "story", route: "/" },
              onLeave: (url) => left.push(url),
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
  return { hook: rendered.result, left };
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
    ids: new Set(["docked"]),
    newTabFollows: new Set(),
    appThemeScope: new Set(),
    ownsChrome: new Set(),
    allowsEmpty: new Set(),
    showsUnfocused: new Set(),
  });
});

afterEach(() => {
  cleanup();
  uninstallPlacements();
  setFocusedApp(undefined);
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
});

function focused(hook: { current: ReturnType<typeof useHarness> }) {
  const { tabs, focusedTabId } = hook.current.tabs;
  const tab = tabs.find((t) => t.tabId === focusedTabId)!;
  return {
    appId: tab.appId,
    route: tab.store.getRoute().map((s) => [s.paneId, s.params]),
  };
}

describe("useOpenPane inside an embedded tab set, outside every surface", () => {
  it("opens the embedded app's pane in the embed's focused tab; the page's URL stays", async () => {
    const { hook, left } = await mountEmbedded();
    expect(hook.current.tabs.contained).toBe(true);

    await act(async () => {
      hook.current.open(storyChapterPane, { id: "x" }, { mode: "root" });
    });

    expect(focused(hook)).toEqual({
      appId: "story",
      route: [["embedded-open-story-chapter", { id: "x" }]],
    });
    expect(left).toEqual([]);
    expect(window.location.pathname).toBe("/pages");
  });

  it("an open of the page's own app moves the embed, never the page", async () => {
    const { hook, left } = await mountEmbedded();

    await act(async () => {
      hook.current.open(pagesGuidePane, {}, { mode: "root" });
    });

    expect(focused(hook)).toEqual({
      appId: "pages",
      route: [["embedded-open-pages-guide", {}]],
    });
    expect(left).toEqual([]);
    expect(window.location.pathname).toBe("/pages");
  });

  it("an append lands after the embed's route, not the page's", async () => {
    const { hook } = await mountEmbedded();
    await act(async () => {
      hook.current.open(storyChapterPane, { id: "a" }, { mode: "root" });
    });

    await act(async () => {
      hook.current.open(pagesGuidePane, {}, { mode: "append" });
    });

    expect(focused(hook)).toEqual({
      appId: "story",
      route: [
        ["embedded-open-story-chapter", { id: "a" }],
        ["embedded-open-pages-guide", {}],
      ],
    });
    expect(window.location.pathname).toBe("/pages");
  });
});
