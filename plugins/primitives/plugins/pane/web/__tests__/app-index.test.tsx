import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import type { LoadedPlugin } from "@plugins/framework/plugins/web-sdk/core";
import {
  type AnyPane,
  Pane,
  type PaneStore,
  useIndexMatch,
  usePaneMatch,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { computeOpen } from "../pane";
import { createTestSurfaceStore, TestSurface } from "../testing";
import { symbol } from "@plugins/ui/plugins/icons/core";

// `appIndex` is a boolean, not a path: which app a pane is the index OF comes
// from the `app` it already declares. This suite pins what that buys — the
// resolution itself, the claim a pane can no longer make about someone else's
// app, and the two invariants that used to fail silently (an index pane with a
// URL of its own, and two index panes for one app).

const appA = defineApp({
  id: "ai-a",
  name: "App index A",
  basePath: "/app",
  icon: symbol("science"),
});
const appB = defineApp({
  id: "ai-b",
  name: "App index B",
  basePath: "/other",
  icon: symbol("science"),
});

function plugin(id: string, panes: AnyPane[]) {
  return {
    id,
    description: "app-index test fixture",
    contributions: panes.map((pane) => Pane.Register({ pane })),
  } as unknown as LoadedPlugin;
}

/** Prints the id of whichever pane the surface's bare root resolves to. */
function IndexProbe({ basePath }: { basePath: string }) {
  const id = useIndexMatch(basePath)?.panes[0]?.pane.id ?? "none";
  return <div data-testid="index">{id}</div>;
}

/** Prints the surface's matched pane ids, left to right. */
function MatchProbe() {
  const ids = usePaneMatch()?.panes.map((e) => e.pane.id) ?? [];
  return <div data-testid="match">{ids.join(",")}</div>;
}

let store: PaneStore;

beforeEach(() => {
  store = createTestSurfaceStore({ live: false });
});

afterEach(cleanup);

describe("appIndex", () => {
  it("resolves the index pane from its own app's basePath", () => {
    const indexRoute = defineRoute({ id: "ai-index-a", segment: "" });
    const indexPane = Pane.define({
      route: indexRoute,
      app: appA,
      appIndex: true,
      component: () => null,
    });

    const view = render(
      <TestSurface
        store={store}
        basePath="/app"
        plugins={[plugin("ai-p1", [indexPane])]}
      >
        <IndexProbe basePath="/app" />
      </TestSurface>,
    );

    expect(view.getByTestId("index").textContent).toBe("ai-index-a");
  });

  it("is not the index of an app it does not belong to", () => {
    // A pane whose home is app A cannot claim app B's bare root — it names no
    // path, so there is nothing to point at the wrong app.
    const indexRoute = defineRoute({ id: "ai-index-b", segment: "" });
    const indexPane = Pane.define({
      route: indexRoute,
      app: appA,
      appIndex: true,
      component: () => null,
    });

    const view = render(
      <TestSurface
        store={store}
        basePath={appB.basePath}
        plugins={[plugin("ai-p2", [indexPane])]}
      >
        <IndexProbe basePath={appB.basePath} />
      </TestSurface>,
    );

    expect(view.getByTestId("index").textContent).toBe("none");
  });

  it("rejects an index pane that owns a URL segment", () => {
    const badRoute = defineRoute({
      id: "ai-index-segmented",
      segment: "somewhere",
    });
    const bad = Pane.define({
      route: badRoute,
      app: appA,
      // This combination is now a TYPE error: `appIndex` is only offered on a
      // segment-less route. The runtime assertion below is kept as defence for
      // the untyped `AnyPane` path, so the case still has to be constructed.
      // @ts-expect-error appIndex is `never` on a route that owns a segment
      appIndex: true,
      component: () => null,
    });

    expect(() =>
      render(
        <TestSurface
          store={store}
          basePath="/app"
          plugins={[plugin("ai-p3", [bad])]}
        >
          <IndexProbe basePath="/app" />
        </TestSurface>,
      ),
    ).toThrow(/cannot have a segment of its own/);
  });

  it("rejects a second index pane for the same app", () => {
    const firstRoute = defineRoute({ id: "ai-index-first", segment: "" });
    const first = Pane.define({
      route: firstRoute,
      app: appA,
      appIndex: true,
      component: () => null,
    });
    const secondRoute = defineRoute({ id: "ai-index-second", segment: "" });
    const second = Pane.define({
      route: secondRoute,
      app: appA,
      appIndex: true,
      component: () => null,
    });

    expect(() =>
      render(
        <TestSurface
          store={store}
          basePath="/app"
          plugins={[plugin("ai-p4", [first, second])]}
        >
          <IndexProbe basePath="/app" />
        </TestSurface>,
      ),
    ).toThrow(/Pane index collision/);
  });
});

describe("an index pane is never a route slot", () => {
  // It has no URL part of its own: as a slot it would be a column the URL does
  // not name, gone on reload (the agent manager's Prototypes column was one).
  const index = Pane.define({
    route: defineRoute({ id: "nis-index", segment: "" }),
    app: appA,
    appIndex: true,
    component: () => null,
  });
  const childRoute = defineRoute({
    id: "nis-child",
    segment: "item/:id",
    parent: defineRoute({ id: "nis-index", segment: "" }),
  });
  const child = Pane.define({
    route: childRoute,
    app: appA,
    useResolve: false,
    component: () => null,
  });
  const other = Pane.define({
    route: defineRoute({ id: "nis-other", segment: "other" }),
    app: appA,
    component: () => null,
  });

  for (const mode of ["push", "swap", "append"] as const) {
    it(`refuses a "${mode}" open (only "root")`, () => {
      store.restoreRoute([{ paneId: "nis-other", params: {} }]);
      const route = store.getRoute();
      expect(() =>
        computeOpen(route, route[0]!.instanceId, index._internal, {}, { mode }),
      ).toThrow(/index pane: it has no URL part of its own/);
    });
  }

  it("opens at the root as the app's bare root (the empty route)", () => {
    store.restoreRoute([{ paneId: "nis-other", params: {} }]);
    const next = computeOpen(
      store.getRoute(),
      undefined,
      index._internal,
      {},
      {
        mode: "root",
      },
    );
    expect(next.route).toEqual([]);
    expect(next.landing?.pane).toBe(index._internal);
  });

  it("is skipped as the declared ancestor of a from-scratch open", () => {
    render(
      <TestSurface
        store={store}
        basePath="/app"
        plugins={[plugin("nis-p", [index, child, other])]}
      >
        <MatchProbe />
      </TestSurface>,
    );
    const next = computeOpen(
      store.getRoute(),
      undefined,
      child._internal,
      { id: "x" },
      { mode: "root" },
    );
    expect(next.route.map((s) => s.paneId)).toEqual(["nis-child"]);
    expect(store.routeUrl(next.route)).toBe("/app/item/x");
  });
});

describe("companion", () => {
  // One fixture for the block: the registry is rebuilt from each render's
  // plugins, so the three cases share these panes.
  const index = Pane.define({
    route: defineRoute({ id: "cmp-index", segment: "" }),
    app: appA,
    appIndex: true,
    component: () => null,
  });
  const companion = Pane.define({
    route: defineRoute({ id: "cmp-preview", segment: "cmp-preview/:id" }),
    app: appA,
    companion: true,
    useResolve: false,
    component: () => null,
  });
  const plain = Pane.define({
    route: defineRoute({ id: "cmp-plain", segment: "cmp-plain/:id" }),
    app: appA,
    useResolve: false,
    component: () => null,
  });
  const fixture = (): AnyPane[] => [index, companion, plain];

  function renderMatch(panes: AnyPane[], id: string) {
    return render(
      <TestSurface
        store={store}
        basePath="/app"
        plugins={[plugin(`cmp-${id}`, panes)]}
      >
        <MatchProbe />
      </TestSurface>,
    );
  }

  it("keeps the index pane beside a companion at the route's head", () => {
    const panes = fixture();
    store.restoreRoute([{ paneId: "cmp-preview", params: { id: "1" } }]);
    const view = renderMatch(panes, "head");
    expect(view.getByTestId("match").textContent).toBe("cmp-index,cmp-preview");
  });

  it("leaves a companion deeper in the route alone", () => {
    const panes = fixture();
    store.restoreRoute([
      { paneId: "cmp-plain", params: { id: "1" } },
      { paneId: "cmp-preview", params: { id: "2" } },
    ]);
    const view = renderMatch(panes, "deep");
    expect(view.getByTestId("match").textContent).toBe("cmp-plain,cmp-preview");
  });

  it("does not add the index beside an ordinary pane", () => {
    const panes = fixture();
    store.restoreRoute([{ paneId: "cmp-plain", params: { id: "1" } }]);
    const view = renderMatch(panes, "plain");
    expect(view.getByTestId("match").textContent).toBe("cmp-plain");
  });
});
