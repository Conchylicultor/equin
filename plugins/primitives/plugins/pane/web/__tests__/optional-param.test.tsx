import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  PaneInstanceContext,
  parseUrl,
  setLiveStore,
  useSyncPaneRegistry,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { buildRouteUrl } from "../pane";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { createTestSurfaceStore, TestSurface, defaultStore } from "../testing";

// A VIEW OF A PANE HAS AN ADDRESS.
//
// An optional last `:param?` gives a pane's view state (which tab, which stage)
// a URL while the bare one stays valid, and `useSetParams()` changes it without
// minting a new instance. This suite pins the three things that makes true: the
// parser reads both shapes and falls back when the longer one leads nowhere,
// the builder omits an absent optional, and an in-place rewrite keeps the
// instance while every read sees the new params.

const optApp = defineApp({
  id: "optional-param-app",
  name: "Optional param test app",
  // Rooted at "/": the surfaces here run at the bare base path, and a route
  // headed by another app's pane would be handed to that app.
  basePath: "/",
  iconKey: "science",
});

/** The prototype-detail shape: an entity, then an optional view of it. */
const detailRoute = defineRoute({
  id: "opt-detail",
  segment: "proto/:name/:stage?",
});
const detailPane = Pane.define({
  route: detailRoute,
  app: optApp,
  useResolve: false,
  component: () => null,
});

/** A pane that can sit to the right of the detail. */
const kidRoute = defineRoute({ id: "opt-kid", segment: "kid/:id" });
const kidPane = Pane.define({
  route: kidRoute,
  app: optApp,
  useResolve: false,
  component: () => null,
});

/**
 * Two segments claiming the same start of a URL — the real
 * `t/:taskId` / `t/:pluginId/:tableName` pair — so the longer match can lead
 * into a dead end the shorter one does not.
 */
const shortRoute = defineRoute({ id: "opt-short", segment: "t/:a" });
const shortPane = Pane.define({
  route: shortRoute,
  app: optApp,
  useResolve: false,
  component: () => null,
});
const longRoute = defineRoute({ id: "opt-long", segment: "t/:a/:b" });
const longPane = Pane.define({
  route: longRoute,
  app: optApp,
  useResolve: false,
  component: () => null,
});
const convRoute = defineRoute({ id: "opt-conv", segment: "c/:convId" });
const convPane = Pane.define({
  route: convRoute,
  app: optApp,
  useResolve: false,
  component: () => null,
});

/** Keyed `;view`: a view of the song, beside the positional optional bar. */
const songRoute = defineRoute({
  id: "opt-song",
  segment: "song/:id/:bar?;view",
});
const songPane = Pane.define({
  route: songRoute,
  app: optApp,
  useResolve: false,
  component: () => null,
});
/** Keyed params alone address no entity, so no `useResolve` is asked for. */
const listRoute = defineRoute({ id: "opt-list", segment: "list;filter" });
const listPane = Pane.define({
  route: listRoute,
  app: optApp,
  component: () => null,
});

const plugins = [
  {
    id: "optional-param-test-plugin",
    description: "optional :param? fixture",
    contributions: [
      Pane.Register({ pane: detailPane }),
      Pane.Register({ pane: kidPane }),
      Pane.Register({ pane: shortPane }),
      Pane.Register({ pane: longPane }),
      Pane.Register({ pane: convPane }),
      Pane.Register({ pane: songPane }),
      Pane.Register({ pane: listPane }),
    ],
  } as unknown as LoadedPlugin,
];

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

/** The (paneId, params) chain a URL parses to, or "unresolved". */
function parsed(path: string) {
  const r = parseUrl(path);
  if (r.status === "unresolved") return "unresolved";
  return r.slots.map((s) => [s.paneId, s.params]);
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

describe("parsing an optional :param?", () => {
  it("reads the bare URL and the URL with the view", () => {
    expect(parsed("/proto/x")).toEqual([["opt-detail", { name: "x" }]]);
    expect(parsed("/proto/x/compare")).toEqual([
      ["opt-detail", { name: "x", stage: "compare" }],
    ]);
  });

  it("falls back to without it when the next part belongs to another pane", () => {
    expect(parsed("/proto/x/kid/7")).toEqual([
      ["opt-detail", { name: "x" }],
      ["opt-kid", { id: "7" }],
    ]);
    expect(parsed("/proto/x/compare/kid/7")).toEqual([
      ["opt-detail", { name: "x", stage: "compare" }],
      ["opt-kid", { id: "7" }],
    ]);
  });

  it("stays unresolved when no reading parses the whole URL", () => {
    expect(parsed("/proto/x/compare/nope")).toBe("unresolved");
  });
});

describe("two segments claiming the same start of a URL", () => {
  it("takes the longer one when it parses the whole URL", () => {
    expect(parsed("/t/1/2")).toEqual([["opt-long", { a: "1", b: "2" }]]);
  });

  it("falls back to the shorter one when the longer leads into a dead end", () => {
    // `t/:a/:b` eats `t/1/c`, leaving `2` — which nothing matches. Taking the
    // longer match blindly made this parseable URL `unresolved`.
    expect(parsed("/t/1/c/2")).toEqual([
      ["opt-short", { a: "1" }],
      ["opt-conv", { convId: "2" }],
    ]);
  });
});

describe("building an optional :param?", () => {
  it("omits it when absent", () => {
    store.restoreRoute([{ paneId: "opt-detail", params: { name: "x" } }]);
    expect(buildRouteUrl(store.getRoute())).toBe("/proto/x");
  });
});

/** A control rendered inside the detail pane, rewriting its own params. */
function SetStage({ stage }: { stage: string }) {
  const setParams = detailPane.useSetParams();
  return (
    <button type="button" onClick={() => setParams({ name: "x", stage })}>
      set
    </button>
  );
}

describe("useSetParams", () => {
  function mountOnDetail(stage: string): HTMLElement {
    store.restoreRoute([
      { paneId: "opt-detail", params: { name: "x" } },
      { paneId: "opt-kid", params: { id: "7" } },
    ]);
    const view = render(
      <TestSurface store={store} plugins={plugins} basePath="">
        <PaneInstanceContext.Provider value={store.getRoute()[0]!.instanceId}>
          <SetStage stage={stage} />
        </PaneInstanceContext.Provider>
      </TestSurface>,
    );
    return view.getByRole("button");
  }

  it("rewrites the address and keeps the instance and the panes after it", () => {
    const button = mountOnDetail("compare");
    const [before, kidBefore] = store.getRoute();
    // Resolve once so the per-uuid entry cache is warm — the rewrite must not
    // be served the entry that still carries the old params.
    expect(store.resolveRoute(store.getRoute())!.panes[0]!.params).toEqual({
      name: "x",
    });

    button.click();

    const [after, kidAfter] = store.getRoute();
    expect(after!.instanceId).toBe(before!.instanceId);
    expect(after!.uuid).toBe(before!.uuid);
    expect(after!.params).toEqual({ name: "x", stage: "compare" });
    expect(kidAfter).toBe(kidBefore);
    expect(window.location.pathname).toBe("/proto/x/compare/kid/7");
    expect(store.resolveRoute(store.getRoute())!.panes[0]!.params).toEqual({
      name: "x",
      stage: "compare",
    });
  });

  it("is a no-op when the params are unchanged", () => {
    const button = mountOnDetail("compare");
    button.click();
    const route = store.getRoute();
    button.click();
    expect(store.getRoute()).toBe(route);
  });

  it("throws outside a pane instance — there is nothing to rewrite", () => {
    expect(() =>
      render(
        <TestSurface store={store} plugins={plugins} basePath="">
          <SetStage stage="compare" />
        </TestSurface>,
      ),
    ).toThrow(/outside a pane instance/);
  });
});

describe("keyed `;name` params", () => {
  it("parse off the pane's last part, beside the positional ones", () => {
    expect(parsed("/song/a")).toEqual([["opt-song", { id: "a" }]]);
    expect(parsed("/song/a;view=notation")).toEqual([
      ["opt-song", { id: "a", view: "notation" }],
    ]);
    expect(parsed("/song/a/3;view=notation")).toEqual([
      ["opt-song", { id: "a", bar: "3", view: "notation" }],
    ]);
    expect(parsed("/list;filter=open")).toEqual([
      ["opt-list", { filter: "open" }],
    ]);
  });

  it("stay scoped to their pane in a multi-pane URL", () => {
    expect(parsed("/song/a;view=notation/kid/7")).toEqual([
      ["opt-song", { id: "a", view: "notation" }],
      ["opt-kid", { id: "7" }],
    ]);
  });

  it("drop an undeclared key rather than making the URL unroutable", () => {
    expect(parsed("/song/a;stale=1")).toEqual([["opt-song", { id: "a" }]]);
  });

  it("are not read off a part before the pane's last", () => {
    // `fillSegment` never writes `/song/a;view=n/3` — the bar arm rejects it,
    // and without the bar the trailing `3` matches no pane.
    expect(parsed("/song/a;view=n/3")).toBe("unresolved");
  });

  it("leave a pane that declares none reading `;` as plain text", () => {
    expect(parsed("/c/a;b=1")).toEqual([["opt-conv", { convId: "a;b=1" }]]);
  });

  it("round-trip through the builder", () => {
    store.restoreRoute([
      { paneId: "opt-song", params: { id: "a", bar: "3", view: "notation" } },
      { paneId: "opt-kid", params: { id: "7" } },
    ]);
    const url = buildRouteUrl(store.getRoute());
    expect(url).toBe("/song/a/3;view=notation/kid/7");
    expect(parsed(url)).toEqual([
      ["opt-song", { id: "a", bar: "3", view: "notation" }],
      ["opt-kid", { id: "7" }],
    ]);
  });
});
