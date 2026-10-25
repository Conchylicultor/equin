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
// Every pane carries the reserved `;view` (`RESERVED_VIEW_PARAM`): a surface
// showing one of several views binds it through `usePaneViewParam`, so its
// view is part of the pane's URL. An app's landing pane — no slot, no URL part
// of its own — carries it on the base path (`/lib;view=all`). This suite pins
// the parse, the build, the in-place REPLACE write, the landing pane, and the
// one-claimant rule.

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
    description: "reserved ;view fixture",
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

describe("parsing the reserved `;view`", () => {
  it("reads it off a pane that declares no keyed params", () => {
    expect(parsed("/vp-list;view=open")).toEqual({
      slots: [["vp-list", { view: "open" }]],
      index: {},
    });
  });

  it("reads it beside a pane's declared keyed params", () => {
    expect(parsed("/vp-song/a;lens=n;view=all")).toEqual({
      slots: [["vp-song", { id: "a", lens: "n", view: "all" }]],
      index: {},
    });
  });

  it("reads a leading `;…` part as the landing pane's params", () => {
    expect(parsed("/;view=all")).toEqual({ slots: [], index: { view: "all" } });
    expect(stripBasePath("/lib;view=all", "/lib")).toBe("/;view=all");
  });
});

/** Binds the enclosing instance's `;view` and hands it to the test. */
function Bind({
  claimant = "surface",
  onBind,
}: {
  claimant?: string;
  onBind: (p: PaneViewParam | null) => void;
}) {
  onBind(usePaneViewParam(claimant));
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
  it("writes the slot's `;view` in place, replacing the history entry", () => {
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

    expect(window.location.pathname).toBe("/vp-list;view=open");
    expect(window.history.length).toBe(historyLength);
    const after = store.getRoute()[0]!;
    expect(after.instanceId).toBe(before.instanceId);
    const entry = store.resolveRoute(store.getRoute())!.panes[0]!;
    expect(entry.params).toEqual({});
    expect(entry.view).toBe("open");
    expect(bound!.value).toBe("open");
  });

  it("is kept by the pane's own useSetParams", () => {
    store.restoreRoute([
      { paneId: "vp-song", params: { id: "a", view: "all" } },
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
      view: "all",
    });
  });

  it("holds the landing pane's view on the base path", () => {
    store.clearRoute();
    let bound: PaneViewParam | null = null;
    render(
      <TestSurface store={store} plugins={plugins} basePath="/lib">
        <InFirstInstance>
          <Bind onBind={(p) => (bound = p)} />
        </InFirstInstance>
      </TestSurface>,
    );
    expect(bound).not.toBeNull();

    act(() => bound!.set("all"));

    expect(window.location.pathname).toBe("/lib;view=all");
    expect(store.getRoute()).toEqual([]);
    expect(store.getIndexParams()).toEqual({ view: "all" });
    expect(bound!.value).toBe("all");
  });

  it("refuses a second surface claiming the same key", () => {
    store.restoreRoute([{ paneId: "vp-list", params: {} }]);
    expect(() =>
      render(
        <TestSurface store={store} plugins={plugins} basePath="">
          <InFirstInstance>
            <Bind claimant="first" onBind={() => {}} />
            <Bind claimant="second" onBind={() => {}} />
          </InFirstInstance>
        </TestSurface>,
      ),
    ).toThrow(/already bound to "first"/);
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
