import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

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
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { clickProps } from "@plugins/primitives/plugins/link-gesture/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { createTestSurfaceStore, TestSurface, defaultStore } from "../testing";
import { symbol } from "@plugins/ui/plugins/icons/core";

// ⌥-CLICK KEEPS THE OTHERS.
//
// A plain open from B in `A | B | C | D` replaces what stands right of B
// (`A | B | E`); ⌥-click inserts instead (`A | B | E | C | D`). A plain close of
// C drops everything right of it (`A | B`); ⌥-close drops only C
// (`A | B | D`) — and whatever only C addressed.

const app = defineApp({
  id: "keep-app",
  name: "Keep test app",
  basePath: "/keep",
  icon: symbol("science"),
});

const make = (id: string, segment: string) =>
  Pane.define({
    route: defineRoute({ id, segment }),
    app,
    component: () => null,
  });
const aPane = make("keep-a", "a");
const bPane = make("keep-b", "b");
const cPane = make("keep-c", "c");
const dPane = make("keep-d", "d");
const ePane = make("keep-e", "e");
const parentRoute = defineRoute({ id: "keep-parent", segment: "p/:pid" });
const parentPane = Pane.define({
  route: parentRoute,
  app,
  useResolve: false,
  component: () => null,
});
const childPane = Pane.define({
  route: defineRoute({ id: "keep-child", segment: "k", parent: parentRoute }),
  app,
  component: () => null,
});

const all = [aPane, bPane, cPane, dPane, ePane, parentPane, childPane];
const testPlugin = {
  id: "keep-others-test-plugin",
  description: "keep-others fixture",
  contributions: all.map((pane) => Pane.Register({ pane })),
} as unknown as LoadedPlugin;
const plugins = [testPlugin];

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

function OpenE() {
  const openPane = useOpenPane();
  return (
    <button type="button" {...openPane.link(ePane, {}, { mode: "push" })}>
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
  store.setBasePath("/keep");
});

afterEach(() => {
  cleanup();
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
});

const ids = () => store.getRoute().map((s) => s.paneId.replace("keep-", ""));

function seed(
  panes: string[],
  params: Record<string, Record<string, string>> = {},
) {
  store.restoreRoute(
    panes.map((p) => ({ paneId: `keep-${p}`, params: params[p] ?? {} })),
  );
}

function openFrom(callerIndex: number, alt: boolean) {
  const caller = store.getRoute()[callerIndex]!.instanceId;
  const view = render(
    <TestSurface store={store} plugins={plugins} basePath="/keep">
      <PaneInstanceContext.Provider value={caller}>
        <OpenE />
      </PaneInstanceContext.Provider>
    </TestSurface>,
  );
  fireEvent.click(view.getByRole("button"), { altKey: alt });
}

function closeAt(index: number, alt: boolean) {
  const slot = store.getRoute()[index]!;
  const pane = all.find((p) => p._internal.id === slot.paneId)!;
  const view = render(
    <button
      type="button"
      {...clickProps(() => store.close(pane._internal, slot.instanceId))}
    >
      close
    </button>,
  );
  fireEvent.click(view.getByRole("button"), { altKey: alt });
}

describe("⌥-open inserts beside the caller", () => {
  it("plain click replaces the panes right of the caller", () => {
    seed(["a", "b", "c", "d"]);
    openFrom(1, false);
    expect(ids()).toEqual(["a", "b", "e"]);
  });

  it("⌥-click inserts right after the caller, keeping the rest", () => {
    seed(["a", "b", "c", "d"]);
    openFrom(1, true);
    expect(ids()).toEqual(["a", "b", "e", "c", "d"]);
  });

  it("⌥-click from the last pane appends", () => {
    seed(["a", "b"]);
    openFrom(1, true);
    expect(ids()).toEqual(["a", "b", "e"]);
  });

  it("⌥-click when the target already stands right after is a no-op", () => {
    seed(["a", "b", "e", "c"]);
    openFrom(1, true);
    expect(ids()).toEqual(["a", "b", "e", "c"]);
  });
});

describe("⌥-close removes only that pane", () => {
  it("plain close drops everything right of it", () => {
    seed(["a", "b", "c", "d"]);
    closeAt(2, false);
    expect(ids()).toEqual(["a", "b"]);
  });

  it("⌥-close keeps the panes right of it", () => {
    seed(["a", "b", "c", "d"]);
    closeAt(2, true);
    expect(ids()).toEqual(["a", "b", "d"]);
  });

  it("⌥-close also drops a pane chained through the closed one", () => {
    seed(["a", "parent", "child", "d"], { parent: { pid: "1" } });
    closeAt(1, true);
    expect(ids()).toEqual(["a", "d"]);
  });
});
