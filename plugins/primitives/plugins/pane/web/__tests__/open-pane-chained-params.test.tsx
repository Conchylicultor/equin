import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  PaneInstanceContext,
  setLiveStore,
  useOpenPane,
  useSyncPaneRegistry,
  type OpenPaneFn,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { createTestSurfaceStore, TestSurface, defaultStore } from "../testing";

// AN OPEN NEVER DISCARDS A PARAM THE CALLER SUPPLIED.
//
// A pane's `params` are its route's CHAINED set — every ancestor's `:name` plus
// its own — because that is what a URL needs, and `tsc` makes the opener supply
// all of them. `useOpenPane`'s three relative branches nonetheless built the
// target's slot from its OWN params alone, so the ancestor half of what the
// caller was forced to pass was deleted by the callee: a deployment row clicked
// inside another pane opened `/…/dep/<id>` with no server in it, and Expand on
// that pane then threw out of `buildRouteUrl` AFTER the store had already
// committed the route — leaving it holding an address whose URL never landed.
//
// This suite pins the rule and the shape of its one derivation: an ancestor is
// inserted only when it can CARRY something, so a paramless one never appears
// as a surprise column beside a task chip.

const chainApp = defineApp({
  id: "chain-app",
  name: "Chained params test app",
  // Rooted at "/": the surfaces here run at the bare base path, and a route
  // headed by another app's pane would be handed to that app.
  basePath: "/",
  iconKey: "science",
});

/** A foreign caller: in nobody's declared chain, the way a conversation is. */
const convRoute = defineRoute({ id: "chain-conv", segment: "c/:convId" });
const convPane = Pane.define({
  route: convRoute,
  app: chainApp,
  useResolve: false,
  component: () => null,
});

/** A PARAMFUL ancestor — the `server/:serverId` shape. */
const serverRoute = defineRoute({
  id: "chain-server",
  segment: "srv/:serverId",
});
const serverPane = Pane.define({
  route: serverRoute,
  app: chainApp,
  useResolve: false,
  component: () => null,
});
const depRoute = defineRoute({
  id: "chain-dep",
  segment: "dep/:depId",
  parent: serverRoute,
});
const depPane = Pane.define({
  route: depRoute,
  app: chainApp,
  useResolve: false,
  component: () => null,
});

/** A PARAMLESS ancestor — the tasks-root / prototype-gallery shape. */
const listRoute = defineRoute({ id: "chain-list", segment: "list" });
const listPane = Pane.define({
  route: listRoute,
  app: chainApp,
  component: () => null,
});
const itemRoute = defineRoute({
  id: "chain-item",
  segment: "item/:itemId",
  parent: listRoute,
});
const itemPane = Pane.define({
  route: itemRoute,
  app: chainApp,
  useResolve: false,
  component: () => null,
});

/** No ancestors at all — the regression baseline. */
const plainRoute = defineRoute({ id: "chain-plain", segment: "plain" });
const plainPane = Pane.define({
  route: plainRoute,
  app: chainApp,
  component: () => null,
});

const testPlugin = {
  id: "open-pane-chained-params-test-plugin",
  description: "chained-params open fixture",
  contributions: [
    Pane.Register({ pane: convPane }),
    Pane.Register({ pane: serverPane }),
    Pane.Register({ pane: depPane }),
    Pane.Register({ pane: listPane }),
    Pane.Register({ pane: itemPane }),
    Pane.Register({ pane: plainPane }),
  ],
} as unknown as LoadedPlugin;

const plugins = [testPlugin];

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

/**
 * A button that runs one open. Rendered under a `PaneInstanceContext` it is a
 * pane's own control (a row inside a column); rendered bare it is global chrome
 * with no caller to be relative to — the two halves of `useOpenPane`.
 */
function OpenButton({ run }: { run: (open: OpenPaneFn) => void }) {
  const openPane = useOpenPane();
  return (
    <button type="button" onClick={() => run(openPane)}>
      open
    </button>
  );
}

let store: PaneStore;

beforeAll(() => {
  // Populate the module-global pane registry once; it survives unmount.
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

/** Seed a route, then render `run`'s button as a control of slot `callerIndex`. */
function mount(
  seed: Array<{ paneId: string; params: Record<string, string> }>,
  run: (open: OpenPaneFn) => void,
  callerIndex?: number,
): HTMLElement {
  store.restoreRoute(seed);
  const callerInstanceId =
    callerIndex === undefined
      ? undefined
      : store.getRoute()[callerIndex]!.instanceId;
  const view = render(
    <TestSurface store={store} plugins={plugins} basePath="">
      <PaneInstanceContext.Provider value={callerInstanceId}>
        <OpenButton run={run} />
      </PaneInstanceContext.Provider>
    </TestSurface>,
  );
  return view.getByRole("button");
}

const ids = () => store.getRoute().map((s) => s.paneId);
const params = () => store.getRoute().map((s) => s.params);

describe("a relative open carries the caller's ancestor params", () => {
  it("materializes a PARAMFUL declared ancestor the prefix does not hold", () => {
    const button = mount(
      [{ paneId: "chain-conv", params: { convId: "7" } }],
      (open) =>
        open(depPane, { serverId: "S1", depId: "D1" }, { mode: "push" }),
      0,
    );
    button.click();

    expect(ids()).toEqual(["chain-conv", "chain-server", "chain-dep"]);
    expect(params()).toEqual([
      { convId: "7" },
      { serverId: "S1" },
      { depId: "D1" },
    ]);
    expect(window.location.pathname).toBe("/c/7/srv/S1/dep/D1");
  });

  it("does NOT materialize a PARAMLESS declared ancestor — no surprise column", () => {
    const button = mount(
      [{ paneId: "chain-conv", params: { convId: "7" } }],
      (open) => open(itemPane, { itemId: "I1" }, { mode: "push" }),
      0,
    );
    button.click();

    expect(ids()).toEqual(["chain-conv", "chain-item"]);
    expect(window.location.pathname).toBe("/c/7/item/I1");
  });

  it("inserts the ancestor on a swap too, not only a push", () => {
    const button = mount(
      [
        { paneId: "chain-conv", params: { convId: "7" } },
        { paneId: "chain-plain", params: {} },
      ],
      (open) =>
        open(depPane, { serverId: "S1", depId: "D1" }, { mode: "swap" }),
      1,
    );
    button.click();

    expect(ids()).toEqual(["chain-conv", "chain-server", "chain-dep"]);
    expect(window.location.pathname).toBe("/c/7/srv/S1/dep/D1");
  });
});

describe("a prefix that cannot host the address", () => {
  it("falls back to the from-scratch build rather than producing a wrong URL", () => {
    // The prefix names server A; the row that was clicked belongs to server B.
    // That is ordinary data, not a programming error — so the open rebuilds
    // instead of leaving `srv/A` standing in front of B's deployment.
    const button = mount(
      [
        { paneId: "chain-server", params: { serverId: "A" } },
        { paneId: "chain-conv", params: { convId: "7" } },
      ],
      (open) => open(depPane, { serverId: "B", depId: "D1" }, { mode: "push" }),
      1,
    );
    button.click();

    expect(ids()).toEqual(["chain-server", "chain-dep"]);
    expect(params()).toEqual([{ serverId: "B" }, { depId: "D1" }]);
    expect(window.location.pathname).toBe("/srv/B/dep/D1");
  });

  it("stops the caller-less dedup from replacing a leaf under a stale ancestor", () => {
    // No caller pane (global chrome), and the target is already in the route
    // with the SAME own params — which used to make the open a no-op, so
    // clicking a deployment on another server did nothing at all.
    const button = mount(
      [
        { paneId: "chain-server", params: { serverId: "A" } },
        { paneId: "chain-dep", params: { depId: "D1" } },
      ],
      (open) => open(depPane, { serverId: "B", depId: "D1" }, { mode: "push" }),
    );
    button.click();

    expect(ids()).toEqual(["chain-server", "chain-dep"]);
    expect(params()).toEqual([{ serverId: "B" }, { depId: "D1" }]);
    expect(window.location.pathname).toBe("/srv/B/dep/D1");
  });
});

describe("promote no longer leaves the store holding an uncommittable route", () => {
  it("re-roots a pushed pane whose ancestor the push now carries", () => {
    const button = mount(
      [{ paneId: "chain-conv", params: { convId: "7" } }],
      (open) =>
        open(depPane, { serverId: "S1", depId: "D1" }, { mode: "push" }),
      0,
    );
    button.click();

    const dep = store.getRoute().at(-1)!;
    expect(() =>
      store.promote(depPane._internal, dep.instanceId),
    ).not.toThrow();

    expect(ids()).toEqual(["chain-server", "chain-dep"]);
    expect(window.location.pathname).toBe("/srv/S1/dep/D1");
  });

  it("re-roots a deep-linked route that genuinely lacks the ancestor", () => {
    // `/c/7/dep/D1` parses to exactly this: a pane sitting without its declared
    // ancestor, and nothing anywhere supplying `:serverId`. The ancestor used to
    // be minted param-less, and `buildRouteUrl` then threw AFTER `setRoute` had
    // committed — the store kept a route the URL never got.
    mount(
      [
        { paneId: "chain-conv", params: { convId: "7" } },
        { paneId: "chain-dep", params: { depId: "D1" } },
      ],
      () => undefined,
      1,
    );
    const dep = store.getRoute()[1]!;

    expect(() =>
      store.promote(depPane._internal, dep.instanceId),
    ).not.toThrow();

    // Nothing was supplied for the ancestor, so nothing is discarded by leaving
    // it out — and the shorter route parses straight back to itself.
    expect(ids()).toEqual(["chain-dep"]);
    expect(window.location.pathname).toBe("/dep/D1");
  });
});

describe("routes without a declared chain are untouched", () => {
  it("a plain push appends the target and nothing else", () => {
    const button = mount(
      [{ paneId: "chain-conv", params: { convId: "7" } }],
      (open) => open(plainPane, {}, { mode: "push" }),
      0,
    );
    button.click();

    expect(ids()).toEqual(["chain-conv", "chain-plain"]);
    expect(params()).toEqual([{ convId: "7" }, {}]);
    expect(window.location.pathname).toBe("/c/7/plain");
  });

  it("a same-pane same-params swap is still a no-op", () => {
    const button = mount(
      [
        { paneId: "chain-conv", params: { convId: "7" } },
        { paneId: "chain-item", params: { itemId: "I1" } },
      ],
      (open) => open(itemPane, { itemId: "I1" }, { mode: "swap" }),
      1,
    );
    const before = store.getRoute();
    button.click();

    // Same array identity: the column was not rebuilt, so the pane did not
    // remount for a click that changed nothing.
    expect(store.getRoute()).toBe(before);
  });
});
