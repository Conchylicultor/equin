import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  PaneInstanceContext,
  parseUrl,
  setLiveStore,
  stripBasePath,
  usePaneMatch,
  usePaneViewParam,
  useSyncPaneRegistry,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import type { PaneViewParam } from "../pane";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { createTestSurfaceStore, TestSurface, defaultStore } from "../testing";
import { symbol } from "@plugins/ui/plugins/icons/core";

// THE VIEW ON SCREEN HAS AN ADDRESS, WITH NOTHING TO DECLARE.
//
// Every pane carries surface view keys (`;view.<surface>`, `surfaceViewKey`):
// a surface showing one of several views binds its own key through
// `usePaneViewParam(surface)`, so its view is part of the pane's URL and any
// number of surfaces in one pane bind side by side. An app's landing pane — no
// slot, no URL part of its own — carries them on the base path
// (`/lib;view.lib=all`). This suite pins the parse, the build (declared keys
// first, surface keys sorted), the in-place REPLACE write and its removal, the
// landing pane, and `useSetParams` keeping them.

const rootApp = defineApp({
  id: "view-param-root",
  name: "View param root app",
  basePath: "/",
  icon: symbol("science"),
});
const libApp = defineApp({
  id: "view-param-lib",
  name: "View param lib app",
  basePath: "/lib",
  icon: symbol("science"),
});

const listPane = Pane.define({
  route: defineRoute({ id: "vp-list", segment: "vp-list" }),
  app: rootApp,
  component: () => null,
});
const songPane = Pane.define({
  route: defineRoute({ id: "vp-song", segment: "vp-song/:id;lens" }),
  app: rootApp,
  useResolve: false,
  component: () => null,
});
const libIndexPane = Pane.define({
  route: defineRoute({ id: "vp-lib-index", segment: "" }),
  app: libApp,
  appIndex: true,
  component: () => null,
});

const plugins = [
  {
    id: "view-param-test-plugin",
    description: "surface view keys fixture",
    contributions: [
      Pane.Register({ pane: listPane }),
      Pane.Register({ pane: songPane }),
      Pane.Register({ pane: libIndexPane }),
    ],
  } as unknown as LoadedPlugin,
];

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

let store: PaneStore;

beforeAll(() => {
  render(
    <PluginProvider plugins={plugins}>
      <RegistrySync />
    </PluginProvider>,
  );
  cleanup();
});

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  store = createTestSurfaceStore();
});

afterEach(() => {
  cleanup();
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
});

function parsed(path: string) {
  const r = parseUrl(path);
  if (r.status === "unresolved") return "unresolved";
  return { slots: r.slots.map((s) => [s.paneId, s.params]), index: r.index };
}

describe("parsing surface view keys", () => {
  it("reads them off a pane that declares no keyed params", () => {
    expect(parsed("/vp-list;view.b=x;view.a=open")).toEqual({
      slots: [["vp-list", { "view.a": "open", "view.b": "x" }]],
      index: {},
    });
  });

  it("reads them beside a pane's declared keyed params", () => {
    expect(parsed("/vp-song/a;lens=n;view.song.notes=all")).toEqual({
      slots: [["vp-song", { id: "a", lens: "n", "view.song.notes": "all" }]],
      index: {},
    });
  });

  it("drops the retired bare `;view=` (an old link still routes)", () => {
    expect(parsed("/vp-list;view=open")).toEqual({
      slots: [["vp-list", {}]],
      index: {},
    });
    expect(parsed("/vp-song/a;view=open")).toEqual({
      slots: [["vp-song", { id: "a" }]],
      index: {},
    });
  });

  it("keeps any other raw `;` as text on a pane declaring no keyed params", () => {
    expect(parsed("/vp-list;junk=1")).toBe("unresolved");
  });

  it("reads a leading `;…` part as the landing pane's params", () => {
    expect(parsed("/;view.lib=all")).toEqual({
      slots: [],
      index: { "view.lib": "all" },
    });
    expect(stripBasePath("/lib;view.lib=all", "/lib")).toBe("/;view.lib=all");
  });
});

/** Binds the enclosing instance's view of `surface` and hands it to the test. */
function Bind({
  surface = "surface",
  onBind,
}: {
  surface?: string;
  onBind: (p: PaneViewParam | null) => void;
}) {
  onBind(usePaneViewParam(surface));
  return null;
}

/** Renders `children` inside the match's FIRST instance. */
function InFirstInstance({ children }: { children: ReactNode }) {
  const match = usePaneMatch();
  const first = match?.panes[0];
  if (!first) return null;
  return (
    <PaneInstanceContext.Provider value={first.instanceId}>
      {children}
    </PaneInstanceContext.Provider>
  );
}

describe("usePaneViewParam", () => {
  it("writes the surface's key in place, replacing the history entry", () => {
    store.restoreRoute([{ paneId: "vp-list", params: {} }]);
    const before = store.getRoute()[0]!;
    let bound: PaneViewParam | null = null;
    render(
      <TestSurface store={store} plugins={plugins} basePath="">
        <InFirstInstance>
          <Bind onBind={(p) => (bound = p)} />
        </InFirstInstance>
      </TestSurface>,
    );
    expect(bound).not.toBeNull();
    expect(bound!.value).toBeUndefined();
    const historyLength = window.history.length;

    act(() => bound!.set("open"));

    expect(window.location.pathname).toBe("/vp-list;view.surface=open");
    expect(window.history.length).toBe(historyLength);
    const after = store.getRoute()[0]!;
    expect(after.instanceId).toBe(before.instanceId);
    const entry = store.resolveRoute(store.getRoute())!.panes[0]!;
    expect(entry.params).toEqual({});
    expect(entry.views).toEqual({ surface: "open" });
    expect(bound!.value).toBe("open");

    act(() => bound!.set(undefined));

    expect(window.location.pathname).toBe("/vp-list");
    expect(window.history.length).toBe(historyLength);
    expect(bound!.value).toBeUndefined();
  });

  it("binds two surfaces of one pane side by side, keys sorted after declared ones", () => {
    store.restoreRoute([{ paneId: "vp-song", params: { id: "a", lens: "n" } }]);
    let first: PaneViewParam | null = null;
    let second: PaneViewParam | null = null;
    render(
      <TestSurface store={store} plugins={plugins} basePath="">
        <InFirstInstance>
          <Bind surface="zeta.list" onBind={(p) => (first = p)} />
          <Bind surface="alpha" onBind={(p) => (second = p)} />
        </InFirstInstance>
      </TestSurface>,
    );

    act(() => first!.set("x"));
    act(() => second!.set("y"));

    expect(window.location.pathname).toBe(
      "/vp-song/a;lens=n;view.alpha=y;view.zeta.list=x",
    );
    expect(first!.value).toBe("x");
    expect(second!.value).toBe("y");
  });

  it("is kept by the pane's own useSetParams", () => {
    store.restoreRoute([
      { paneId: "vp-song", params: { id: "a", "view.notes": "all" } },
    ]);
    let setParams: ((p: { id: string; lens?: string }) => void) | null = null;
    function SetLens() {
      setParams = songPane.useSetParams();
      return null;
    }
    render(
      <TestSurface store={store} plugins={plugins} basePath="">
        <InFirstInstance>
          <SetLens />
        </InFirstInstance>
      </TestSurface>,
    );
    act(() => setParams!({ id: "a", lens: "n" }));
    expect(store.getRoute()[0]!.params).toEqual({
      id: "a",
      lens: "n",
      "view.notes": "all",
    });
  });

  it("holds the landing pane's view on the base path", () => {
    store.clearRoute();
    let bound: PaneViewParam | null = null;
    render(
      <TestSurface store={store} plugins={plugins} basePath="/lib">
        <InFirstInstance>
          <Bind surface="lib" onBind={(p) => (bound = p)} />
        </InFirstInstance>
      </TestSurface>,
    );
    expect(bound).not.toBeNull();

    act(() => bound!.set("all"));

    expect(window.location.pathname).toBe("/lib;view.lib=all");
    expect(store.getRoute()).toEqual([]);
    expect(store.getIndexParams()).toEqual({ "view.lib": "all" });
    expect(bound!.value).toBe("all");

    act(() => bound!.set(undefined));

    expect(window.location.pathname).toBe("/lib");
    expect(store.getIndexParams()).toEqual({});
  });

  it("binds nothing outside a pane", () => {
    let bound: PaneViewParam | null | "unset" = "unset";
    render(
      <TestSurface store={store} plugins={plugins} basePath="">
        <Bind onBind={(p) => (bound = p)} />
      </TestSurface>,
    );
    expect(bound).toBeNull();
  });
});
