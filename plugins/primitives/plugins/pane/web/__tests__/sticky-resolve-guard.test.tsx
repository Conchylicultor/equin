import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  Pane,
  type PaneStore,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
// The guard is internal to the plugin — `PaneBox` is what the barrel exports, so
// no layout renderer can paint a pane without its identity/theme stamping. This
// suite is a unit test of the guard itself, so it reaches the internal file
// directly (same plugin, no boundary crossed) rather than through a box.
import { PaneResolveGuard } from "../components/pane-resolve-guard";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { createTestSurfaceStore, TestSurface } from "../testing";

// Local fixture app — this suite is about the resolve guard, not pane homes.
const testApp = defineApp({
  id: "sticky-guard-app",
  name: "Sticky guard test app",
  basePath: "/sticky-guard-app",
  iconKey: "science",
});

// Regression: a resolve hook whose live-state resource flips transiently back to
// `pending` or `error` (e.g. an HTTP-fallback refetch failing under memory pressure) must
// NOT unmount the resolved pane — that would destroy scroll/focus/unsaved draft.
// The guard is sticky-found: once resolved for an identity it stays mounted
// through later `pending` / `error` flips, and only a SETTLED miss downgrades to Not Found.

// A mutable resolve result the test drives frame-by-frame. Every guard render
// reads the current value, so re-rendering after mutating it exercises a flip.
let resolveResult: ResolveResult = { status: "pending" };

// A real defined pane: `Pane.define` registers it in the internal→object map
// that the Not-Found fallback chrome (`paneObjectFor`) consults. `useResolve` reads
// the module-level `resolveResult`, so the test owns the resolve outcome.
const testRoute = defineRoute({
  id: "sticky-guard-test",
  segment: "sticky/:id",
});
const testPane = Pane.define({
  route: testRoute,
  app: testApp,
  useResolve: () => resolveResult,
  component: () => <div data-testid="pane-body">resolved</div>,
});

// The guard's Loading / Not-Found chrome calls `useClose()` / `usePromote()`,
// which read the surface's pane store — so the guard must be mounted in a
// surface, not bare. A background store keeps this suite off the URL entirely:
// it drives the resolve hook directly and has no route to derive. With an empty
// route both hooks return null, so no promote/close button renders.
let store: PaneStore;

beforeEach(() => {
  store = createTestSurfaceStore({ live: false });
});

afterEach(() => {
  cleanup();
  resolveResult = { status: "pending" };
});

// A pane whose segment also carries VIEWS of its entity: an optional `:tab?`
// and a keyed `;view`. Its body counts its own mounts.
let viewBodyMounts = 0;
function ViewBody() {
  const [mount] = useState(() => ++viewBodyMounts);
  return <div data-testid="view-body">{mount}</div>;
}
const viewRoute = defineRoute({
  id: "sticky-guard-views",
  segment: "views/:id/:tab?;view",
});
const viewPane = Pane.define({
  route: viewRoute,
  app: testApp,
  useResolve: () => resolveResult,
  component: ViewBody,
});

/** Mount the guard for `id` in a surface. Returned so a case can re-render it. */
function guard(id: string) {
  return (
    <TestSurface store={store}>
      <PaneResolveGuard pane={testPane._internal} params={{ id }} />
    </TestSurface>
  );
}

describe("sticky resolve guard", () => {
  it("keeps the pane mounted when a resolved resource flips back to pending", () => {
    resolveResult = { status: "found" };
    const { getByTestId, queryByText, rerender } = render(guard("a"));
    expect(getByTestId("pane-body")).toBeTruthy();

    // Transient error: settled resource flips back to pending.
    resolveResult = { status: "pending" };
    rerender(guard("a"));

    // The pane body is still mounted; no Loading fallback swapped in.
    expect(getByTestId("pane-body")).toBeTruthy();
    expect(queryByText("Loading…")).toBeNull();
  });

  it("downgrades to Not Found on a settled miss even after it was found (real deletion)", () => {
    resolveResult = { status: "found" };
    const { getByTestId, queryByTestId, getByText, rerender } = render(
      guard("a"),
    );
    expect(getByTestId("pane-body")).toBeTruthy();

    // The resource settles with the row gone — a genuine deletion.
    resolveResult = { status: "missing" };
    rerender(guard("a"));

    expect(queryByTestId("pane-body")).toBeNull();
    expect(getByText("Not Found")).toBeTruthy();
  });

  it("resets stickiness when params change (a swap re-roots the pane in place)", () => {
    // Resolve task "a".
    resolveResult = { status: "found" };
    const { getByTestId, queryByTestId, getAllByText, queryByText, rerender } =
      render(guard("a"));
    expect(getByTestId("pane-body")).toBeTruthy();

    // Swap to task "b" while its resource is still loading. Stickiness from "a"
    // must NOT leak: the guard shows Loading for the new, unresolved identity.
    resolveResult = { status: "pending" };
    rerender(guard("b"));

    expect(queryByTestId("pane-body")).toBeNull();
    expect(queryByText("Not Found")).toBeNull();
    // "Loading…" appears both as the fallback title and inside <Loading/>.
    expect(getAllByText("Loading…").length).toBeGreaterThan(0);
  });

  it("keeps the same pane instance when only a view param changes (`:tab?`, `;view`)", () => {
    resolveResult = { status: "found" };
    const views = (params: Record<string, string>) => (
      <TestSurface store={store}>
        <PaneResolveGuard pane={viewPane._internal} params={params} />
      </TestSurface>
    );
    const { getByTestId, rerender } = render(views({ id: "a" }));
    const first = getByTestId("view-body").textContent;

    rerender(views({ id: "a", view: "grid" }));
    rerender(views({ id: "a", tab: "notes", view: "roll" }));
    expect(getByTestId("view-body").textContent).toBe(first);

    // The entity's own address still remounts.
    rerender(views({ id: "b", view: "roll" }));
    expect(getByTestId("view-body").textContent).not.toBe(first);
  });

  it("keeps the pane mounted when a resolved resource fails transiently", () => {
    resolveResult = { status: "found" };
    const { getByTestId, queryByText, rerender } = render(guard("a"));
    expect(getByTestId("pane-body")).toBeTruthy();

    resolveResult = { status: "error", error: new Error("socket blipped") };
    rerender(guard("a"));

    expect(getByTestId("pane-body")).toBeTruthy();
    expect(queryByText(/socket blipped/)).toBeNull();
  });

  it("renders a failed resolve as the failure with Retry — neither a spinner nor Not Found", () => {
    const refetch = vi.fn(() => Promise.resolve());
    resolveResult = {
      status: "error",
      error: new Error("boom"),
      retry: refetch,
    };
    const { getByText, queryByTestId, queryByText } = render(guard("a"));

    expect(queryByTestId("pane-body")).toBeNull();
    expect(queryByText("Not Found")).toBeNull();
    expect(queryByText("Loading…")).toBeNull();
    expect(getByText(/boom/)).toBeTruthy();

    fireEvent.click(getByText("Retry"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("offers no Retry for a failed resolve that cannot refetch", () => {
    resolveResult = { status: "error", error: new Error("boom") };
    const { getByText, queryByText } = render(guard("a"));
    expect(getByText(/boom/)).toBeTruthy();
    expect(queryByText("Retry")).toBeNull();
  });
});
