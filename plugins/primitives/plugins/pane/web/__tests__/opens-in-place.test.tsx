import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  PaneInstanceContext,
  PaneSurfaceProvider,
  setLiveStore,
  useOpenPane,
  useSyncPaneRegistry,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { createTestSurfaceStore, TestSurface, defaultStore } from "../testing";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { PLAIN_GESTURE } from "@plugins/primitives/plugins/link-gesture/core";

// A NAVIGATOR COLUMN HANDS ITS COLUMN TO WHAT IT OPENS.
//
// `opensInPlace: true` turns a plain right-push from the pane into a swap: the
// list borrowed beside a host (the pages tree, the prototype gallery next to a
// conversation) is replaced by what it opened instead of stacking a column.
// ⌥-click still inserts; a pane without the flag keeps Miller's push.

const app = defineApp({
  id: "oip-app",
  name: "Opens-in-place test app",
  basePath: "/oip",
  icon: symbol("science"),
});

// The app whose surface hosts the borrowed navigator (a conversation's).
const hostApp = defineApp({
  id: "oip-host-app",
  name: "Opens-in-place host app",
  basePath: "/oip-host",
  icon: symbol("science"),
});

const hostPane = Pane.define({
  route: defineRoute({ id: "oip-host", segment: "host/:hid" }),
  app: hostApp,
  useResolve: false,
  component: () => null,
});
const navPane = Pane.define({
  route: defineRoute({ id: "oip-nav", segment: "nav" }),
  app,
  opensInPlace: true,
  component: () => null,
});
const listPane = Pane.define({
  route: defineRoute({ id: "oip-list", segment: "list" }),
  app,
  component: () => null,
});
// Like the prototype canvas: its declared parent is the app's index pane,
// which never takes a slot.
const indexRoute = defineRoute({ id: "oip-index", segment: "" });
const indexPane = Pane.define({
  route: indexRoute,
  app,
  appIndex: true,
  component: () => null,
});
const itemPane = Pane.define({
  route: defineRoute({
    id: "oip-item",
    segment: "item/:iid",
    parent: indexRoute,
  }),
  app,
  useResolve: false,
  component: () => null,
});

const otherItemPane = Pane.define({
  route: defineRoute({ id: "oip-other", segment: "other" }),
  app,
  component: () => null,
});

const all = [hostPane, navPane, listPane, indexPane, itemPane, otherItemPane];
const testPlugin = {
  id: "opens-in-place-test-plugin",
  description: "opens-in-place fixture",
  contributions: all.map((pane) => Pane.Register({ pane })),
} as unknown as LoadedPlugin;
const plugins = [testPlugin];

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

function OpenItem({ side }: { side?: "left" }) {
  const openPane = useOpenPane();
  return (
    <button
      type="button"
      {...openPane.link(
        itemPane,
        { iid: "x" },
        side ? { mode: "push", side } : { mode: "push" },
      )}
    >
      open
    </button>
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
  window.history.replaceState(null, "", "/");
  store = createTestSurfaceStore();
  store.setBasePath("/oip");
});

afterEach(() => {
  cleanup();
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
});

const ids = () => store.getRoute().map((s) => s.paneId.replace("oip-", ""));

const SEED_PARAMS: Record<string, Record<string, string>> = {
  host: { hid: "h" },
  item: { iid: "x" },
};
const NO_PARAMS: Record<string, string> = {};

function seed(panes: string[]) {
  store.restoreRoute(
    panes.map((p) => ({
      paneId: `oip-${p}`,
      params: SEED_PARAMS[p] ?? NO_PARAMS,
    })),
  );
}

function openFrom(
  callerIndex: number,
  { alt = false, side }: { alt?: boolean; side?: "left" } = {},
) {
  const caller = store.getRoute()[callerIndex]!.instanceId;
  const view = render(
    <TestSurface store={store} plugins={plugins} basePath="/oip">
      <PaneInstanceContext.Provider value={caller}>
        <OpenItem side={side} />
      </PaneInstanceContext.Provider>
    </TestSurface>,
  );
  fireEvent.click(view.getByRole("button"), { altKey: alt });
}

describe("opensInPlace", () => {
  it("a plain push from a navigator column takes its column", () => {
    seed(["host", "nav"]);
    openFrom(1);
    expect(ids()).toEqual(["host", "item"]);
  });

  it("drops whatever stood right of the navigator, as a push would", () => {
    seed(["host", "nav", "list"]);
    openFrom(1);
    expect(ids()).toEqual(["host", "item"]);
  });

  it("⌥-click still inserts beside the navigator", () => {
    seed(["host", "nav"]);
    openFrom(1, { alt: true });
    expect(ids()).toEqual(["host", "nav", "item"]);
  });

  it("a left-push keeps the navigator", () => {
    seed(["host", "nav"]);
    openFrom(1, { side: "left" });
    expect(ids()).toEqual(["host", "item", "nav"]);
  });

  it("a pane without the flag keeps Miller's push", () => {
    seed(["host", "list"]);
    openFrom(1);
    expect(ids()).toEqual(["host", "list", "item"]);
  });
});

// THE WAY BACK IS DERIVED FROM THE FLAG.
//
// A pane that stands as its app's first column in ANOTHER app's surface, with
// the app's navigator column gone from the route, gets the header's Back —
// which swaps the navigator back into its column.

function BackButton({
  pane,
}: {
  pane: typeof itemPane | typeof otherItemPane;
}) {
  const back = pane.useReturnToNavigator();
  return back === null ? null : (
    <button type="button" onClick={() => back(PLAIN_GESTURE)}>
      back
    </button>
  );
}

function renderBack(
  callerIndex: number,
  pane: typeof itemPane | typeof otherItemPane,
  surfaceAppId: string,
) {
  const caller = store.getRoute()[callerIndex]!.instanceId;
  return render(
    <PluginProvider plugins={plugins}>
      <PaneSurfaceProvider
        store={store}
        basePath="/oip-host"
        appId={surfaceAppId}
      >
        <PaneInstanceContext.Provider value={caller}>
          <BackButton pane={pane} />
        </PaneInstanceContext.Provider>
      </PaneSurfaceProvider>
    </PluginProvider>,
  );
}

describe("useReturnToNavigator", () => {
  it("swaps the navigator back into the column its item took", () => {
    seed(["host", "item"]);
    const view = renderBack(1, itemPane, hostApp.id);
    fireEvent.click(view.getByRole("button"));
    expect(ids()).toEqual(["host", "nav"]);
  });

  it("is absent while the navigator column is still in the route", () => {
    seed(["host", "nav", "item"]);
    const view = renderBack(2, itemPane, hostApp.id);
    expect(view.queryByRole("button")).toBeNull();
  });

  it("is absent on a column with its own app's pane to its left", () => {
    seed(["host", "item", "other"]);
    const view = renderBack(2, otherItemPane, hostApp.id);
    expect(view.queryByRole("button")).toBeNull();
  });

  it("is absent in the pane's own app, whose own navigator is the way", () => {
    seed(["item"]);
    const view = renderBack(0, itemPane, app.id);
    expect(view.queryByRole("button")).toBeNull();
  });
});
