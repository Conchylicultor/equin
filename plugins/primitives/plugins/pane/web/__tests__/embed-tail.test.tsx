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
  usePaneMatch,
  usePaneViews,
  useSyncPaneRegistry,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import {
  defineApp,
  defineRoute,
  embedTailPath,
} from "@plugins/primitives/plugins/pane/core";
import type { PaneViews } from "../pane";
import { createTestSurfaceStore, TestSurface, defaultStore } from "../testing";
import { symbol } from "@plugins/ui/plugins/icons/core";

// AN EMBED'S PLACE IS THE TAIL OF ITS PAGE'S URL.
//
// The two reserved surface views of the pane instance hosting an embed
// (`view.embed`: its location; `view.embed.full`: maximized) are spelled, on
// the route's LAST instance, as `<the page's URL>/at/<location>[;full=1]`.
// This suite pins the build and the parse on both owners (the landing pane, a
// slot), the plain spelling elsewhere, and that a route with a real `at`
// segment keeps meaning itself.

const rootApp = defineApp({
  id: "embed-tail-root",
  name: "Embed tail root app",
  basePath: "/",
  icon: symbol("science"),
});
const siteApp = defineApp({
  id: "embed-tail-site",
  name: "Embed tail site app",
  basePath: "/site",
  icon: symbol("science"),
});

const hostPane = Pane.define({
  route: defineRoute({ id: "et-host", segment: "et-host" }),
  app: rootApp,
  component: () => null,
});
const childPane = Pane.define({
  route: defineRoute({ id: "et-child", segment: "et-child" }),
  app: rootApp,
  component: () => null,
});
// A route with a static `at` of its own (as Files' `/<fs>/at/<path>`).
const filesPane = Pane.define({
  route: defineRoute({ id: "et-files", segment: "et-files/:fs/at/:path*" }),
  app: rootApp,
  useResolve: false,
  component: () => null,
});
const siteIndexPane = Pane.define({
  route: defineRoute({ id: "et-site-index", segment: "" }),
  app: siteApp,
  appIndex: true,
  component: () => null,
});

const plugins = [
  {
    id: "embed-tail-test-plugin",
    description: "embed tail fixture",
    contributions: [
      Pane.Register({ pane: hostPane }),
      Pane.Register({ pane: childPane }),
      Pane.Register({ pane: filesPane }),
      Pane.Register({ pane: siteIndexPane }),
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
  const r = parseUrl(path, "/");
  if (r.status === "unresolved") return "unresolved";
  return { slots: r.slots.map((s) => [s.paneId, s.params]), index: r.index };
}

const PLACE = "view.embed";
const FULL = "view.embed.full";

describe("parsing an embed tail", () => {
  it("puts it on the landing pane when the route has no slot", () => {
    expect(parsed("/at/agents/c/x")).toEqual({
      slots: [],
      index: { [PLACE]: "/agents/c/x" },
    });
    expect(parsed("/;view.lib=all/at/desktop/sonata;full=1")).toEqual({
      slots: [],
      index: {
        "view.lib": "all",
        [PLACE]: "/desktop/sonata",
        [FULL]: "1",
      },
    });
  });

  it("puts it on the last slot of the chain before it", () => {
    expect(parsed("/et-host/et-child/at/agents")).toEqual({
      slots: [
        ["et-host", {}],
        ["et-child", { [PLACE]: "/agents" }],
      ],
      index: {},
    });
  });

  it("decodes the location's own encoded parts (its keyed params, a %2F)", () => {
    expect(parsed("/at/sonata%3Bview.lib%3Dall/x%2F")).toEqual({
      slots: [],
      index: { [PLACE]: "/sonata;view.lib=all/x/" },
    });
  });

  it("leaves a route with a real `at` segment alone", () => {
    expect(parsed("/et-files/disk/at/Documents/a")).toEqual({
      slots: [["et-files", { fs: "disk", path: "Documents/a" }]],
      index: {},
    });
  });

  it("reads the flag off a route with no location, on its last slot", () => {
    expect(parsed("/et-host/et-child;full=1")).toEqual({
      slots: [
        ["et-host", {}],
        ["et-child", { [FULL]: "1" }],
      ],
      index: {},
    });
  });

  it("is no tail with nothing after `at`", () => {
    expect(parsed("/et-host/at")).toBe("unresolved");
  });
});

describe("embedTailPath", () => {
  it("spells the tail a script appends to its page", () => {
    expect(embedTailPath("/agents/c/x")).toBe("/at/agents/c/x");
    expect(embedTailPath("/desktop/sonata", { maximized: true })).toBe(
      "/at/desktop/sonata;full=1",
    );
    expect(embedTailPath("/sonata;view.lib=all")).toBe(
      "/at/sonata%3Bview.lib%3Dall",
    );
  });

  it("refuses the root, which no tail spells", () => {
    expect(() => embedTailPath("/")).toThrow();
  });
});

/** Binds the enclosing instance's views and hands them to the test. */
function Bind({ onBind }: { onBind: (v: PaneViews | null) => void }) {
  onBind(usePaneViews());
  return null;
}

/** Renders `children` inside the match's instance at `at` (default: first). */
function InInstance({
  at = 0,
  children,
}: {
  at?: number;
  children: ReactNode;
}) {
  const entry = usePaneMatch()?.panes[at];
  if (!entry) return null;
  return (
    <PaneInstanceContext.Provider value={entry.instanceId}>
      {children}
    </PaneInstanceContext.Provider>
  );
}

describe("writing an embed's place", () => {
  it("is the landing pane's tail, round-tripping through the URL", () => {
    store.clearRoute();
    let views: PaneViews | null = null;
    render(
      <TestSurface store={store} plugins={plugins} basePath="/site">
        <InInstance>
          <Bind onBind={(v) => (views = v)} />
        </InInstance>
      </TestSurface>,
    );
    const historyLength = window.history.length;

    act(() => views!.set({ embed: "/agents/c/x" }));
    expect(window.location.pathname).toBe("/site/at/agents/c/x");
    expect(window.history.length).toBe(historyLength);

    act(() => views!.set({ "embed.full": "1" }, "push"));
    expect(window.location.pathname).toBe("/site/at/agents/c/x;full=1");
    expect(window.history.length).toBe(historyLength + 1);
    expect(views!.values).toEqual({ embed: "/agents/c/x", "embed.full": "1" });

    expect(views!.href({ embed: "/pages", "embed.full": undefined })).toBe(
      "/site/at/pages",
    );
    // Nothing written by asking.
    expect(window.location.pathname).toBe("/site/at/agents/c/x;full=1");
  });

  it("spells a maximize with no location as the flag alone", () => {
    store.clearRoute();
    let views: PaneViews | null = null;
    render(
      <TestSurface store={store} plugins={plugins} basePath="/site">
        <InInstance>
          <Bind onBind={(v) => (views = v)} />
        </InInstance>
      </TestSurface>,
    );
    act(() => views!.set({ "embed.full": "1" }));
    expect(window.location.pathname).toBe("/site;full=1");
    expect(parsed("/;full=1")).toEqual({ slots: [], index: { [FULL]: "1" } });
  });

  it("is a tail on the last slot, plain keys on any other", () => {
    store.restoreRoute([
      { paneId: "et-host", params: {} },
      { paneId: "et-child", params: {} },
    ]);
    let first: PaneViews | null = null;
    let last: PaneViews | null = null;
    render(
      <TestSurface store={store} plugins={plugins} basePath="">
        <InInstance at={0}>
          <Bind onBind={(v) => (first = v)} />
        </InInstance>
        <InInstance at={1}>
          <Bind onBind={(v) => (last = v)} />
        </InInstance>
      </TestSurface>,
    );
    act(() => last!.set({ embed: "/agents" }));
    expect(window.location.pathname).toBe("/et-host/et-child/at/agents");
    act(() => first!.set({ embed: "/pages" }));
    expect(window.location.pathname).toBe(
      "/et-host;view.embed=%2Fpages/et-child/at/agents",
    );
    expect(parsed("/et-host;view.embed=%2Fpages/et-child/at/agents")).toEqual({
      slots: [
        ["et-host", { [PLACE]: "/pages" }],
        ["et-child", { [PLACE]: "/agents" }],
      ],
      index: {},
    });
  });

  it("keeps plain keys on a last slot whose segment ends open (a wildcard)", () => {
    store.restoreRoute([
      { paneId: "et-files", params: { fs: "disk", path: "a" } },
    ]);
    let views: PaneViews | null = null;
    render(
      <TestSurface store={store} plugins={plugins} basePath="">
        <InInstance>
          <Bind onBind={(v) => (views = v)} />
        </InInstance>
      </TestSurface>,
    );
    act(() => views!.set({ embed: "/agents" }));
    expect(window.location.pathname).toBe(
      "/et-files/disk/at/a;view.embed=%2Fagents",
    );
    expect(parsed("/et-files/disk/at/a;view.embed=%2Fagents")).toEqual({
      slots: [["et-files", { fs: "disk", path: "a", [PLACE]: "/agents" }]],
      index: {},
    });
  });
});
