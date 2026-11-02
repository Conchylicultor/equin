import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  PaneInstanceContext,
  defineRoute,
  useSyncPaneRegistry,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { createTestSurfaceStore, TestSurface } from "../testing";

// A satellite pane asks which instance of a repeatable pane it hangs off. With
// two conversation columns open, the satellite beside the SECOND one must read
// the second — `useRouteEntry()` reads the first, which is how a sub-agent pane
// opened from a child conversation looked for its sub-agent in the parent.

const app = defineApp({
  id: "enclosing-app",
  name: "Enclosing",
  basePath: "/enc",
  icon: symbol("science"),
});

const convPane = Pane.define({
  route: defineRoute({ id: "enc-conv", segment: "c/:convId" }),
  app,
  useResolve: false,
  component: () => null,
});
const satellitePane = Pane.define({
  route: defineRoute({ id: "enc-sat", segment: "sat" }),
  app,
  component: () => null,
});

const plugins = [
  {
    id: "use-enclosing-test-plugin",
    description: "useEnclosing fixture",
    contributions: [
      Pane.Register({ pane: convPane }),
      Pane.Register({ pane: satellitePane }),
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
  store.setBasePath("/enc");
  store.restoreRoute([
    { paneId: "enc-conv", params: { convId: "parent" } },
    { paneId: "enc-conv", params: { convId: "child" } },
    { paneId: "enc-sat", params: {} },
  ]);
});

afterEach(cleanup);

function Reader() {
  const entry = convPane.useEnclosing();
  return <output>{entry === null ? "none" : entry.params.convId}</output>;
}

function readAt(instanceId: number | undefined): string | null {
  const { getByRole } = render(
    <TestSurface store={store} plugins={plugins} basePath="/enc">
      {instanceId === undefined ? (
        <Reader />
      ) : (
        <PaneInstanceContext.Provider value={instanceId}>
          <Reader />
        </PaneInstanceContext.Provider>
      )}
    </TestSurface>,
  );
  const text = getByRole("status").textContent;
  cleanup();
  return text;
}

describe("useEnclosing", () => {
  it("reads the nearest instance before a satellite, not the first", () => {
    expect(readAt(store.getRoute()[2]!.instanceId)).toBe("child");
  });

  it("reads the caller's own instance", () => {
    expect(readAt(store.getRoute()[0]!.instanceId)).toBe("parent");
    expect(readAt(store.getRoute()[1]!.instanceId)).toBe("child");
  });

  it("is null outside every pane instance", () => {
    expect(readAt(undefined)).toBe("none");
  });

  it("is null outside every surface", () => {
    const { getByRole } = render(<Reader />);
    expect(getByRole("status").textContent).toBe("none");
  });
});
