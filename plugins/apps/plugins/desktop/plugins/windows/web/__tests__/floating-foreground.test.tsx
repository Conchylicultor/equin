import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// Mock the children FloatingForeground renders so mounting it exercises ONLY
// its reconcile effect, not any child provider / DOM. Specifiers resolve to the
// same modules floating-foreground.tsx imports as `./…` (it lives beside them
// in `web/components/`).
vi.mock("../components/overview-layer", () => ({ OverviewLayer: () => null }));
vi.mock("../components/desk-frame", () => ({ DeskFrame: () => null }));
vi.mock("../components/snap-preview-overlay", () => ({
  SnapPreviewOverlay: () => null,
}));
vi.mock("../components/tab-drag-overlay", () => ({ TabDragOverlay: () => null }));
vi.mock("../components/floating-tabs-bridge", () => ({
  FloatingTabsBridge: () => null,
}));
// No plugin registry here: the overlay slot reads as empty.
vi.mock("../slots", () => ({
  Desktop: { Overlay: { useContributions: () => [] } },
}));

import { FloatingForeground } from "../components/floating-foreground";
import {
  bringWindowToFront,
  getFloatingWindow,
  snapWindowDirection,
  splitTabToNewWindow,
  windowForTab,
  type Geometry,
} from "../hooks/use-floating-windows";

// The window store is module-global and accumulates across tests in this file
// (mirroring `use-floating-windows.desktops.test.ts`), so each test uses its OWN
// tab id and asserts on that window by id rather than assuming a clean slate.
// `splitTabToNewWindow(tabId, point)` on an unknown tab mints a fresh singleton
// window at `point` — the only imperative window-creation path reachable without
// React — which we use as the fixture.
function clone(geo: Geometry): Geometry {
  return JSON.parse(JSON.stringify(geo)) as Geometry;
}

afterEach(() => {
  cleanup();
});

describe("FloatingForeground reconcile lifecycle", () => {
  it("a surface-mode switch (unmount) does NOT wipe live window geometry", () => {
    // Seed a window for "t1" and drive it to a clearly NON-default geometry:
    // moved (custom origin), resized/snapped (maximize + restore box), raised.
    splitTabToNewWindow("t1", { x: 321, y: 234 });
    const wid = windowForTab("t1")!;
    snapWindowDirection(wid, "up"); // → snap "maximize" + captures a restore box
    bringWindowToFront(wid);

    const before = clone(getFloatingWindow(wid)!.geo);
    // Sanity: the seeded geometry really is off the default cascade / free state.
    expect(before.x).toBe(321);
    expect(before.y).toBe(234);
    expect(before.snap).toBe("maximize");
    expect(before.restore).toBeDefined();

    // Mounting then unmounting the Foreground models a windows→docked/solo switch
    // (the dispatcher renders it only in `floating` mode). Its keyed reconcile
    // runs with both ids live, so nothing is pruned; unmount must NOT touch the
    // store.
    const { unmount } = render(
      <FloatingForeground tabIds={["t1"]} retainedTabIds={["t1"]} />,
    );
    unmount();

    // Core regression assertion: the window still exists with the SAME geometry.
    const after = getFloatingWindow(wid);
    expect(after).toBeDefined();
    expect(after!.geo).toEqual(before);
  });

  it("a genuine last-close still prunes the now-empty window", () => {
    // A distinct fixture window for "t2".
    splitTabToNewWindow("t2");
    const wid = windowForTab("t2")!;
    expect(getFloatingWindow(wid)).toBeDefined();

    // Mount live, then re-render with empty live+retained sets — the keyed effect
    // re-runs `pruneWindows(∅, ∅)` while mounted (the last-tab-close path), which
    // must delete the empty window so the fix does not leak stale windows.
    const { rerender } = render(
      <FloatingForeground tabIds={["t2"]} retainedTabIds={["t2"]} />,
    );
    rerender(<FloatingForeground tabIds={[]} retainedTabIds={[]} />);

    expect(getFloatingWindow(wid)).toBeUndefined();
  });
});
