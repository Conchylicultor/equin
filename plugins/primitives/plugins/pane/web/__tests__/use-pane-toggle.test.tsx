import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  Pane,
  PaneInstanceContext,
  defineRoute,
  paneTarget,
  usePaneToggle,
  useSyncPaneRegistry,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { createTestSurfaceStore, TestSurface } from "../testing";

// An id chip opens its referent's pane as a column beside the surface holding
// it, and a second click on the same chip closes that column — but a chip for
// ANOTHER referent of the same pane opens it in place of the first.

const app = defineApp({
  id: "toggle-app",
  name: "Toggle",
  basePath: "/tog",
  icon: symbol("science"),
});

const hostPane = Pane.define({
  route: defineRoute({ id: "tog-host", segment: "host" }),
  app,
  component: () => null,
});
const itemPane = Pane.define({
  route: defineRoute({ id: "tog-item", segment: "item/:itemId" }),
  app,
  useResolve: false,
  component: () => null,
});

const plugins = [
  {
    id: "use-pane-toggle-test-plugin",
    description: "usePaneToggle fixture",
    contributions: [
      Pane.Register({ pane: hostPane }),
      Pane.Register({ pane: itemPane }),
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
  store.setBasePath("/tog");
  store.restoreRoute([{ paneId: "tog-host", params: {} }]);
});

afterEach(cleanup);

/** The toggle's link for `itemId`, as the host pane's chip would build it. */
function linkFor(itemId: string): LinkTarget {
  const seen: { link?: LinkTarget } = {};
  function Chip() {
    const link = usePaneToggle()(paneTarget(itemPane, { itemId }));
    useEffect(() => {
      seen.link = link;
    });
    return <output>{itemId}</output>;
  }
  render(
    <TestSurface store={store} plugins={plugins} basePath="/tog">
      <PaneInstanceContext.Provider value={store.getRoute()[0]!.instanceId}>
        <Chip />
      </PaneInstanceContext.Provider>
    </TestSurface>,
  );
  cleanup();
  if (!seen.link) throw new Error("the chip did not render");
  return seen.link;
}

/** A plain click on the link — built outside `act`, which defers a render. */
function click(link: LinkTarget): void {
  act(() => link.open());
}

const items = () =>
  store
    .getRoute()
    .filter((s) => s.paneId === "tog-item")
    .map((s) => s.params.itemId);

describe("usePaneToggle", () => {
  it("opens the pane beside the caller", () => {
    click(linkFor("a"));
    expect(items()).toEqual(["a"]);
  });

  it("closes the column it opened on a second click", () => {
    click(linkFor("a"));
    click(linkFor("a"));
    expect(items()).toEqual([]);
  });

  it("opens another referent in place of the first", () => {
    click(linkFor("a"));
    click(linkFor("b"));
    expect(items()).toEqual(["b"]);
  });

  it("links to the opened route, never the close", () => {
    click(linkFor("a"));
    expect(linkFor("a").href()).toContain("/item/a");
  });
});
