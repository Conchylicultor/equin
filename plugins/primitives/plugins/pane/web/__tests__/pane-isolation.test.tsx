import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  createPaneStore,
  Pane,
  setLiveStore,
  useSyncPaneRegistry,
} from "@plugins/primitives/plugins/pane/web";
import { defaultStore } from "../testing";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";

// Proves the per-tab pane-store isolation invariants the multi-tab refactor
// relies on. Each app tab owns its own `PaneStore` (independent route +
// `prevResolvedByUuid` memo cache); exactly one is `live` and a global popstate
// must drive only that one. The pane *definitions* (registry, instanceId
// counter) stay module-global and shared.

// A real registered pane is needed for `resolveRoute` (it consults the
// module-global registry). We register one self-contained test pane through a
// minimal PluginProvider + `useSyncPaneRegistry` — no full plugin graph, so the
// suite stays boundary-clean (imports only this plugin + the web-sdk it already
// depends on).
// Local fixture app — this suite is about store isolation, not pane homes.
const testApp = defineApp({
  id: "iso-app",
  name: "Isolation test app",
  basePath: "/iso-app",
  iconKey: "science",
});

const testRoute = defineRoute({ id: "iso-test", segment: "iso/:id" });
const testPane = Pane.define({
  route: testRoute,
  app: testApp,
  useResolve: false,
  component: () => null,
});

const testPlugin = {
  id: "iso-test-plugin",
  description: "pane-isolation test fixture",
  contributions: [Pane.Register({ pane: testPane })],
} as unknown as LoadedPlugin;

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

beforeAll(() => {
  // Populate the module-global pane registry with `iso-test` so `resolveRoute`
  // can match it. Persists after unmount (registry is module-global).
  render(
    <PluginProvider plugins={[testPlugin]}>
      <RegistrySync />
    </PluginProvider>,
  );
  cleanup();
});

beforeEach(() => {
  setLiveStore(defaultStore);
});

afterEach(() => {
  cleanup();
  setLiveStore(defaultStore);
});

describe("instanceId uniqueness across concurrently-mounted tabs", () => {
  it("assigns a distinct instanceId to every slot, regardless of store", () => {
    const ids = new Set<number>();
    for (let i = 0; i < 5; i++) {
      const store = createPaneStore({ live: false });
      store.restoreRoute([{ paneId: "iso-test", params: { id: String(i) } }]);
      ids.add(store.getRoute()[0]!.instanceId);
    }
    expect(ids.size).toBe(5);
  });
});

describe("prevResolvedByUuid memo cache", () => {
  it("reuses MatchEntry identity for an unchanged route (per store)", () => {
    const store = createPaneStore({ live: false });
    store.restoreRoute([{ paneId: "iso-test", params: { id: "1" } }]);
    const route = store.getRoute();

    const m1 = store.resolveRoute(route);
    const m2 = store.resolveRoute(route);
    expect(m1).not.toBeNull();
    // Same slots (same uuid) → memoized entry, stable object identity.
    expect(m2!.panes[0]).toBe(m1!.panes[0]);

    // A param change is a new slot (new uuid) → fresh MatchEntry identity.
    store.restoreRoute([{ paneId: "iso-test", params: { id: "2" } }]);
    const m3 = store.resolveRoute(store.getRoute());
    expect(m3!.panes[0]).not.toBe(m1!.panes[0]);
  });

  it("keeps each store's cache independent", () => {
    const a = createPaneStore({ live: false });
    const b = createPaneStore({ live: false });
    a.restoreRoute([{ paneId: "iso-test", params: { id: "x" } }]);
    b.restoreRoute([{ paneId: "iso-test", params: { id: "x" } }]);

    const ma = a.resolveRoute(a.getRoute());
    const mb = b.resolveRoute(b.getRoute());
    expect(ma!.panes[0]).not.toBeNull();
    // Distinct stores resolve to distinct MatchEntry objects — no shared cache.
    expect(ma!.panes[0]).not.toBe(mb!.panes[0]);
  });
});

describe("background store ignores global navigation", () => {
  it("routes the focused tab's navigation (global popstate) to the live store only", () => {
    const live = createPaneStore({ live: true });
    setLiveStore(live);
    const background = createPaneStore({ live: false });
    background.restoreRoute([{ paneId: "iso-test", params: { id: "bg" } }]);
    const bgRouteBefore = background.getRoute();

    // The focused tab navigates through the sanctioned store path: a live
    // setRoute writes history + dispatches the global popstate/shell:navigate
    // that every store's listener sees.
    live.restoreRoute([{ paneId: "iso-test", params: { id: "focused" } }]);

    // The live store holds the new route…
    expect(live.getRoute()[0]!.params.id).toBe("focused");
    // …while the background store kept its in-memory route (same ref) despite
    // the global event.
    expect(background.getRoute()).toBe(bgRouteBefore);
    expect(background.getRoute()[0]!.params.id).toBe("bg");
  });

  it("no-ops handleLocationChange on a background store even when history points elsewhere", () => {
    const background = createPaneStore({ live: false });
    background.restoreRoute([{ paneId: "iso-test", params: { id: "bg" } }]);
    const bgRouteBefore = background.getRoute();

    // Drive browser history to a different route via the live store (sanctioned
    // path), then run the background store's handler directly — as a mounted
    // background surface's useSyncPaneRegistry would. The !live gate must keep
    // its route frozen.
    const live = createPaneStore({ live: true });
    setLiveStore(live);
    live.restoreRoute([{ paneId: "iso-test", params: { id: "other" } }]);

    background.handleLocationChange();

    expect(background.getRoute()).toBe(bgRouteBefore);
    expect(background.getRoute()[0]!.params.id).toBe("bg");
  });
});

describe("a background store's pending path", () => {
  it("resolves against the registry from its own path, never the page URL", () => {
    const live = createPaneStore({ live: true });
    setLiveStore(live);
    live.restoreRoute([{ paneId: "iso-test", params: { id: "page" } }]);

    // An in-process embed (or a background tab restored early) seeds a path
    // of its own; the registry sync's `handleLocationChange` upgrades it.
    const background = createPaneStore({ live: false });
    background.seedPending("iso/seeded");
    background.handleLocationChange();

    expect(background.getRouteState().kind).toBe("resolved");
    expect(background.getRoute()[0]!.params.id).toBe("seeded");
  });

  it("stays pending while no registered pane matches it", () => {
    const background = createPaneStore({ live: false });
    background.seedPending("nowhere/x");
    background.handleLocationChange();
    expect(background.getRouteState()).toEqual({
      kind: "unresolved",
      rawPath: "nowhere/x",
    });
  });
});
