import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  PluginProvider,
  markDeferredLoadComplete,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import { type PaneStore, Pane } from "@plugins/primitives/plugins/pane/web";
import { usePaneRoute } from "../pane";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { createTestSurfaceStore, TestSurface } from "../testing";
import { symbol } from "@plugins/ui/plugins/icons/core";

// Local fixture app — this suite is about URL resolution, not pane homes.
const testApp = defineApp({
  id: "st-app",
  name: "Settle-then-register test app",
  basePath: "/app",
  icon: symbol("science"),
});

const indexRoute = defineRoute({ id: "st-index", segment: "" });
const indexPane = Pane.define({
  route: indexRoute,
  app: testApp,
  appIndex: true,
  component: () => null,
});
const targetRoute = defineRoute({ id: "st-target", segment: "thing/:id" });
const targetPane = Pane.define({
  route: targetRoute,
  app: testApp,
  useResolve: false,
  component: () => null,
});

const indexOnly = {
  id: "st-index-plugin",
  description: "x",
  contributions: [Pane.Register({ pane: indexPane })],
} as unknown as LoadedPlugin;

const withTarget = {
  id: "st-target-plugin",
  description: "x",
  contributions: [
    Pane.Register({ pane: indexPane }),
    Pane.Register({ pane: targetPane }),
  ],
} as unknown as LoadedPlugin;

function Probe({ basePath }: { basePath: string }) {
  const match = usePaneRoute(basePath);
  const label =
    match === null ? "null" : match.panes.map((p) => p.pane.id).join(",");
  return <div data-testid="out">{label}</div>;
}

function setPath(pathname: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { pathname },
  });
}
// A cold direct load has null history.state (no serialized route/pending).
function setNullHistory(): void {
  Object.defineProperty(window, "history", {
    configurable: true,
    writable: true,
    value: { state: null },
  });
}

let store: PaneStore;
beforeEach(() => {
  store = createTestSurfaceStore();
  resetDeferredLoadStateForTests();
});
afterEach(() => cleanup());

function mount(plugins: Parameters<typeof PluginProvider>[0]["plugins"]) {
  return (
    <TestSurface store={store} plugins={plugins}>
      <Probe basePath="/app" />
    </TestSurface>
  );
}

describe("cold deep link: settle THEN register (real cold-boot ordering)", () => {
  it("resolves the deep link when the target pane registers AFTER the deferred tier settled", () => {
    setPath("/app/thing/123");
    setNullHistory();

    // 1. Mount live with only the index registered → unresolved → null.
    const view = render(mount([indexOnly]));
    expect(view.getByTestId("out").textContent).toBe("null");

    // 2. Deferred tier SETTLES while the deep link is still unresolved
    //    (this is what flips DeferredRouteFallback to the NotFound surface).
    markDeferredLoadComplete();
    view.rerender(mount([indexOnly]));
    expect(view.getByTestId("out").textContent).toBe("null");

    // 3. The target pane's plugin finishes loading and registers IN PLACE
    //    (same mounted tree, contributions grow) — the real deferred arrival.
    view.rerender(mount([withTarget]));
    // EXPECT it to re-resolve to the target pane. If it stays "null", that is the
    // stuck-not-found bug.
    expect(view.getByTestId("out").textContent).toBe("st-target");
  });

  it("re-resolves even when history.state.pending was already committed (the cold-deep-link race)", () => {
    // Regression: on a cold deep link the boot tab wiring commits a pending route
    // into history.state (`activate` → `navigatePending`) BEFORE the target
    // pane's deferred plugin loads. handleLocationChange's `state.pending` branch
    // used to restore that unresolved state WITHOUT re-parsing the URL, so the
    // later registration could never re-resolve it — a permanent "This page
    // doesn't exist" for a valid link. The branch now re-parses, so a
    // now-registered pane wins.
    setPath("/app/thing/123");
    Object.defineProperty(window, "history", {
      configurable: true,
      writable: true,
      value: { state: { pending: "thing/123" } },
    });

    const view = render(mount([indexOnly]));
    expect(view.getByTestId("out").textContent).toBe("null");

    markDeferredLoadComplete();
    view.rerender(mount([withTarget]));
    expect(view.getByTestId("out").textContent).toBe("st-target");
  });
});
