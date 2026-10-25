import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";

// What the whole fix is about: switching the surface mode must NOT remount the
// open tabs. The regression it pins is a host that returned its tab container
// wrapped in a portal for one mode and bare for another — two different children
// at one tree position, which React reconciles by deleting the subtree and
// building a new one, taking every tab's scroll, uncommitted edit and iframe
// with it.
//
// Four assertions, because three of them can pass while the bug is back:
// mount/unmount counts and the instance id prove REACT kept the component, and
// the DOM node object proves nobody re-parented the node underneath it (a
// stable-container relocation would keep React happy and still reload an
// iframe).

/** Live probe state, shared with the hoisted `TabSurface` mock below. */
const probe = vi.hoisted(() => ({ mounts: 0, unmounts: 0, minted: 0 }));

/** The surface mode + tab set `SurfaceBody` reads, driven by the tests. */
const tabsState = vi.hoisted(() => ({ mode: "docked-ish" }));

// `TabSurface` stands in for a whole app: it counts its own mounts/unmounts and
// mints a `useState` instance id, which is only re-minted by a real remount.
vi.mock("@plugins/apps-core/plugins/tab-surface/web", async () => {
  const { createElement, useEffect, useState } = await import("react");
  return {
    TabSurface: function TabSurfaceProbe() {
      const [instanceId] = useState(() => `inst-${++probe.minted}`);
      useEffect(() => {
        probe.mounts++;
        return () => {
          probe.unmounts++;
        };
      }, []);
      return createElement("div", {
        "data-testid": "tab-probe",
        "data-instance": instanceId,
      });
    },
  };
});

// The tabs store, reduced to what the body reads: one tab and the surface mode.
// A real `TabsProvider` would drag in the pane store, history and sessionStorage
// for a question none of them are part of.
vi.mock("@plugins/apps-core/plugins/tabs/web", () => ({
  useTabs: () => ({
    tabs: [{ tabId: "t1", appId: "a1", store: null }],
    focusedTabId: "t1",
    titles: {},
    mode: tabsState.mode,
    focusTab: () => {},
    closeTab: () => {},
    exitToPreviousMode: () => {},
  }),
  registerPlacementCapabilities: () => {},
}));

import {
  cn,
  SURFACE_LEVELS,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { SurfaceBody } from "../components/surface-body";
import { Surface, type PlacementDef } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

const testIcon = symbol("add");

/**
 * The app canvas every tab container paints, read from the primitive rather than
 * re-spelled: the container is a `<Theme surface="canvas">`, so this prefix is
 * on the class of EVERY mode's tab — including the empty-registry fallback,
 * which is the whole point of moving the paint off the descriptors. Composed
 * here so these assertions stay pinned to the FRAME mechanics they are about.
 */
const CANVAS = SURFACE_LEVELS.base;

/** A placement that positions inside the surface (docked's shape). */
const containedDef: PlacementDef = {
  id: "docked-ish",
  label: "Contained",
  icon: testIcon,
  default: true,
  frame: "pane",
  themeScope: "app",
};

/** A placement that positions against the viewport (solo's shape). */
const viewportDef: PlacementDef = {
  id: "solo-ish",
  label: "Viewport",
  icon: testIcon,
  frame: "viewport",
  themeScope: "app",
};

/** A placement that is a free box inside the surface (floating's shape). */
const windowDef: PlacementDef = {
  id: "window-ish",
  label: "Window",
  icon: testIcon,
  frame: "window",
  frameClassName: cn("rounded-lg border"),
  visibleWhenUnfocused: true,
};

const placementsPlugin = {
  id: "surface-keepalive-test-placements",
  description: "three fake placements for the mode-switch keep-alive suite",
  contributions: [
    Surface.Placement(containedDef),
    Surface.Placement(viewportDef),
    Surface.Placement(windowDef),
  ],
} as unknown as LoadedPlugin;

/** No placement sub-plugins at all — the empty-registry fallback. */
const emptyPlugin = {
  id: "surface-keepalive-test-no-placements",
  description: "a plugin contributing no placements at all",
  contributions: [],
} as unknown as LoadedPlugin;

function renderSurface() {
  return render(
    <PluginProvider plugins={[placementsPlugin]}>
      <SurfaceBody />
    </PluginProvider>,
  );
}

afterEach(() => {
  cleanup();
  probe.mounts = 0;
  probe.unmounts = 0;
  probe.minted = 0;
  tabsState.mode = containedDef.id;
});

describe("a surface-mode switch keeps every tab mounted", () => {
  it("survives contained → viewport-relative → contained with one mount and one DOM node", () => {
    const { container, rerender } = renderSurface();

    const first = container.querySelector('[data-testid="tab-probe"]');
    expect(first).not.toBeNull();
    expect(probe.mounts).toBe(1);
    const instanceId = first!.getAttribute("data-instance");

    // Enter the viewport-relative mode (the surface's fullscreen switch).
    tabsState.mode = viewportDef.id;
    rerender(
      <PluginProvider plugins={[placementsPlugin]}>
        <SurfaceBody />
      </PluginProvider>,
    );

    const inViewportMode = container.querySelector('[data-testid="tab-probe"]');
    expect(probe.mounts).toBe(1);
    expect(probe.unmounts).toBe(0);
    expect(inViewportMode!.getAttribute("data-instance")).toBe(instanceId);
    // Node identity: the half a re-parent would break while React saw nothing.
    expect(inViewportMode).toBe(first);

    // …and back out again, which is the direction the old portal toggle also
    // remounted on.
    tabsState.mode = containedDef.id;
    rerender(
      <PluginProvider plugins={[placementsPlugin]}>
        <SurfaceBody />
      </PluginProvider>,
    );

    const back = container.querySelector('[data-testid="tab-probe"]');
    expect(probe.mounts).toBe(1);
    expect(probe.unmounts).toBe(0);
    expect(back!.getAttribute("data-instance")).toBe(instanceId);
    expect(back).toBe(first);
  });

  it("hands the tab the active placement's class without moving it", () => {
    const { container, rerender } = renderSurface();

    // Exact strings, not `toContain`: the host resolves a `frame` role to
    // mechanics, so this is where the resolution is pinned to what the modes
    // used to spell out by hand.
    const tabNode = container.querySelector('[data-theme-scope="app:a1"]');
    expect(tabNode!.className).toBe(`${CANVAS} absolute inset-0`);

    tabsState.mode = viewportDef.id;
    rerender(
      <PluginProvider plugins={[placementsPlugin]}>
        <SurfaceBody />
      </PluginProvider>,
    );

    // The SAME node now carries the fullscreen class — restyled, not relocated.
    expect(container.querySelector('[data-theme-scope="app:a1"]')).toBe(
      tabNode,
    );
    expect(tabNode!.className).toBe(`${CANVAS} fixed inset-0 z-overlay`);
    // And it is still a child of the surface, never of <body>.
    expect(container.contains(tabNode)).toBe(true);
  });

  it("drops the backdrop's transform only while a viewport-relative mode is active", () => {
    const { container, rerender } = renderSurface();

    // `firstElementChild` is the backdrop: SurfaceBody's own root element.
    const backdrop = container.firstElementChild!;
    expect(backdrop.className).toContain("transform-gpu");

    tabsState.mode = viewportDef.id;
    rerender(
      <PluginProvider plugins={[placementsPlugin]}>
        <SurfaceBody />
      </PluginProvider>,
    );

    // Without this the fullscreen container's containing block would be the
    // backdrop, and a `fixed inset-0` tab would stop at the content area.
    expect(container.firstElementChild).toBe(backdrop);
    expect(backdrop.className).not.toContain("transform-gpu");

    tabsState.mode = containedDef.id;
    rerender(
      <PluginProvider plugins={[placementsPlugin]}>
        <SurfaceBody />
      </PluginProvider>,
    );
    expect(backdrop.className).toContain("transform-gpu");
  });
});

// A placement declares a `frame` ROLE and the host owns the mechanics, so the
// mapping is the thing that can silently change what every mode looks like.
// These are the exact strings the three modes used to spell out by hand.
describe("the frame role resolves to the container mechanics", () => {
  function classForMode(modeId: string, plugin = placementsPlugin): string {
    tabsState.mode = modeId;
    const { container } = render(
      <PluginProvider plugins={[plugin]}>
        <SurfaceBody />
      </PluginProvider>,
    );
    return container.querySelector('[data-theme-scope="app:a1"]')!.className;
  }

  it("positions a pane frame against the surface", () => {
    expect(classForMode(containedDef.id)).toBe(`${CANVAS} absolute inset-0`);
  });

  it("positions a viewport frame against the window, above the app chrome", () => {
    expect(classForMode(viewportDef.id)).toBe(
      `${CANVAS} fixed inset-0 z-overlay`,
    );
  });

  // `absolute` and `overflow-hidden` belong to the ROLE, not to floating: a
  // window frame that leaks past its own rounded corner is a bug in every
  // conceivable window mode.
  it("clips a window frame to its own corner", () => {
    expect(classForMode(windowDef.id)).toBe(
      `${CANVAS} absolute overflow-hidden rounded-lg border`,
    );
  });

  // Not a separate branch any more, and not even a fallback paint: an empty
  // registry is the bare `pane` frame, and the app canvas comes from the
  // container's own `<Theme surface="canvas">` exactly as it does for a
  // registered mode. The hardcoded fallback that used to be needed here is gone.
  it("falls back to a pane frame when no placement is registered", () => {
    expect(classForMode("", emptyPlugin)).toBe(`${CANVAS} absolute inset-0`);
  });
});
