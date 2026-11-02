import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  openPane,
  Pane,
  PaneInstanceContext,
  parseUrl,
  setLiveStore,
  usePaneMatch,
  usePaneViewParam,
  useSyncPaneRegistry,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import type { PaneViewParam } from "../pane";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { createTestSurfaceStore, TestSurface, defaultStore } from "../testing";
import { symbol } from "@plugins/ui/plugins/icons/core";

// AN APP'S LANDING PANE MAY DECLARE KEYED PARAMS, WRITTEN ON THE BASE PATH.
//
// `segment: ";page"` — no positional part, so the pane is still what the bare
// root shows, and `page` rides the base path (`/lib;page=x`) beside the surface
// view keys. A keyed param is a VIEW of the pane: changing it (useSetParams,
// back/forward) re-renders the SAME mounted instance, never remounts it — the
// whole point (Places' page overlay, which used to be a second pane whose
// open/close unmounted the map).

const libApp = defineApp({
  id: "ikp-lib",
  name: "Index keyed lib app",
  basePath: "/lib",
  icon: symbol("science"),
});

let mounts = 0;
let seenPage: string | undefined;
let setParams: ((p: { page?: string }) => void) | null = null;
let bound: PaneViewParam | null = null;

function LibIndex() {
  const params = libIndexPane.useParams();
  const set = libIndexPane.useSetParams();
  const view = usePaneViewParam("lib");
  // Published after every render (no deps): what the instance last rendered.
  useEffect(() => {
    seenPage = params.page;
    setParams = set;
    bound = view;
  });
  useEffect(() => {
    mounts++;
  }, []);
  return null;
}

const libIndexPane = Pane.define({
  route: defineRoute({ id: "ikp-lib-index", segment: ";page" }),
  app: libApp,
  appIndex: true,
  component: LibIndex,
});

const plugins = [
  {
    id: "index-keyed-param-test-plugin",
    description: "index keyed params fixture",
    contributions: [Pane.Register({ pane: libIndexPane })],
  } as unknown as LoadedPlugin,
];

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

/** The surface's match, each entry keyed by its instance — as a layout renders it. */
function Renderer() {
  const match = usePaneMatch();
  return (
    <>
      {match?.panes.map((e) => (
        <PaneInstanceContext.Provider key={e.uuid} value={e.instanceId}>
          <e.pane.component />
        </PaneInstanceContext.Provider>
      ))}
    </>
  );
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
  mounts = 0;
  seenPage = undefined;
  setParams = null;
  bound = null;
  window.history.replaceState(null, "", "/lib;page=x");
  store = createTestSurfaceStore();
});

afterEach(() => {
  cleanup();
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
});

function mount() {
  render(
    <TestSurface store={store} plugins={plugins} basePath="/lib">
      <Renderer />
    </TestSurface>,
  );
}

describe("an index pane's keyed params", () => {
  it("parse off the base path", () => {
    const r = parseUrl("/;page=x;view.lib=all");
    expect(r).toEqual({
      status: "matched",
      slots: [],
      index: { page: "x", "view.lib": "all" },
    });
  });

  it("`/lib;page=x` resolves the index pane with useParams() = { page: 'x' }", () => {
    mount();
    expect(store.getRoute()).toEqual([]);
    expect(store.getIndexParams()).toEqual({ page: "x" });
    expect(seenPage).toBe("x");
    expect(mounts).toBe(1);
  });

  it("an undeclared key in the URL is ignored by the pane", () => {
    window.history.replaceState(null, "", "/lib;page=x;stale=1");
    store = createTestSurfaceStore();
    mount();
    expect(seenPage).toBe("x");
  });

  it("useSetParams rewrites them in place: same instance, a history push, back restores", () => {
    mount();
    const lengthBefore = window.history.length;

    act(() => setParams!({ page: undefined }));

    expect(seenPage).toBeUndefined();
    expect(window.location.pathname).toBe("/lib");
    expect(store.getIndexParams()).toEqual({});
    expect(window.history.length).toBe(lengthBefore + 1);
    expect(mounts).toBe(1);

    act(() => setParams!({ page: "y" }));
    expect(window.location.pathname).toBe("/lib;page=y");
    expect(seenPage).toBe("y");
    expect(mounts).toBe(1);

    // Back to the closed state, then to `;page=x`: the history entry carries
    // the index params, and the pane re-reads them without remounting.
    act(() => {
      window.history.replaceState(
        { route: [], index: { page: "x" } },
        "",
        "/lib;page=x",
      );
      store.handleLocationChange();
    });
    expect(store.getIndexParams()).toEqual({ page: "x" });
    expect(seenPage).toBe("x");
    expect(mounts).toBe(1);
  });

  it("back/forward (popstate) restores `;page=x` on the same instance", async () => {
    mount();
    act(() => setParams!({ page: undefined }));
    expect(seenPage).toBeUndefined();

    await act(async () => {
      const popped = new Promise<void>((resolve) =>
        window.addEventListener("popstate", () => resolve(), { once: true }),
      );
      window.history.back();
      await popped;
    });

    expect(window.location.pathname).toBe("/lib;page=x");
    expect(store.getIndexParams()).toEqual({ page: "x" });
    expect(seenPage).toBe("x");
    expect(mounts).toBe(1);
  });

  it("keeps the surface views beside them", () => {
    mount();
    act(() => bound!.set("all"));
    expect(window.location.pathname).toBe("/lib;page=x;view.lib=all");

    act(() => setParams!({ page: "y" }));
    expect(window.location.pathname).toBe("/lib;page=y;view.lib=all");
    expect(bound!.value).toBe("all");
    expect(mounts).toBe(1);
  });

  it("openPane at the root lands on the bare root with them", () => {
    window.history.replaceState(null, "", "/lib");
    store = createTestSurfaceStore();
    mount();
    expect(seenPage).toBeUndefined();

    act(() => openPane(libIndexPane, { page: "z" }, { mode: "root" }));

    expect(store.getRoute()).toEqual([]);
    expect(store.getIndexParams()).toEqual({ page: "z" });
    expect(window.location.pathname).toBe("/lib;page=z");
    expect(seenPage).toBe("z");
    expect(mounts).toBe(1);
  });
});
