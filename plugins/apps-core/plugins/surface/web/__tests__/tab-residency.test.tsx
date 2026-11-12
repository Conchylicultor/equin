import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";

// The surface keeps the tabs on screen and the most recently focused hidden
// ones mounted, and unloads the rest (`useResidentTabs`): a browser tab's memory
// is bounded by what is open now, not by every in-app tab ever opened in it.

/** The tab set `SurfaceBody` reads, driven by the tests. */
const tabsState = vi.hoisted(() => ({
  mode: "docked-ish",
  previousMode: "",
  ids: ["t1", "t2", "t3", "t4", "t5"],
  focusedTabId: "t1",
}));

// `TabSurface` reduced to what the body hands it: which tab, and whether its
// app is mounted.
vi.mock(
  "@plugins/apps-core/plugins/tab-surface/web",
  async (importOriginal) => {
    const { createElement } = await import("react");
    return {
      ...(await importOriginal<object>()),
      TabSurface: ({
        tab,
        resident,
      }: {
        tab: { tabId: string };
        resident: boolean;
      }) =>
        createElement("div", {
          "data-testid": "tab-probe",
          "data-tab": tab.tabId,
          "data-resident": String(resident),
        }),
    };
  },
);

vi.mock("@plugins/apps-core/plugins/tabs/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTabs: () => ({
    id: "page",
    contained: false,
    tabs: tabsState.ids.map((tabId) => ({ tabId, appId: "a1", store: null })),
    focusedTabId: tabsState.focusedTabId,
    titles: {},
    mode: tabsState.mode,
    previousMode: tabsState.previousMode,
    focusTab: () => {},
    closeTab: () => {},
    exitToPreviousMode: () => {},
  }),
  usePlacementRegistry: () => ({ install: () => () => {} }),
}));

import { SurfaceBody } from "../components/surface-body";
import { Surface, type PlacementDef } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

const testIcon = symbol("add");

const dockedDef: PlacementDef = {
  id: "docked-ish",
  label: "Docked",
  icon: testIcon,
  default: true,
  frame: "pane",
  themeScope: "app",
};

const soloDef: PlacementDef = {
  id: "solo-ish",
  label: "Solo",
  icon: testIcon,
  frame: "viewport",
  themeScope: "app",
};

const windowDef: PlacementDef = {
  id: "window-ish",
  label: "Window",
  icon: testIcon,
  frame: "window",
  visibleWhenUnfocused: true,
};

const placementsPlugin = {
  id: "surface-residency-test-placements",
  description: "a docked-like and a window-like placement",
  contributions: [
    Surface.Placement(dockedDef),
    Surface.Placement(soloDef),
    Surface.Placement(windowDef),
  ],
} as unknown as LoadedPlugin;

const tree = () => (
  <PluginProvider plugins={[placementsPlugin]}>
    <SurfaceBody />
  </PluginProvider>
);

function residentIds(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll<HTMLElement>('[data-resident="true"]'),
  ].map((el) => el.dataset.tab!);
}

afterEach(() => {
  cleanup();
  tabsState.mode = dockedDef.id;
  tabsState.previousMode = "";
  tabsState.ids = ["t1", "t2", "t3", "t4", "t5"];
  tabsState.focusedTabId = "t1";
});

describe("tab residency", () => {
  it("boots with only the focused tab mounted; every tab keeps its container", () => {
    const { container } = render(tree());
    expect(
      container.querySelectorAll('[data-testid="tab-probe"]'),
    ).toHaveLength(5);
    expect(residentIds(container)).toEqual(["t1"]);
  });

  it("keeps the two most recently focused hidden tabs and unloads older ones", () => {
    const { container, rerender } = render(tree());
    for (const id of ["t2", "t3", "t4"]) {
      tabsState.focusedTabId = id;
      rerender(tree());
    }
    // t4 focused, t3 and t2 the most recent hidden ones; t1 unloaded.
    expect(residentIds(container).sort()).toEqual(["t2", "t3", "t4"]);

    // Back to t2: it was resident, and t1 stays unloaded.
    tabsState.focusedTabId = "t2";
    rerender(tree());
    expect(residentIds(container).sort()).toEqual(["t2", "t3", "t4"]);

    // Back to t1: mounted again, t3 (now least recent) unloaded.
    tabsState.focusedTabId = "t1";
    rerender(tree());
    expect(residentIds(container).sort()).toEqual(["t1", "t2", "t4"]);
  });

  it("keeps every tab mounted in a mode that shows unfocused tabs", () => {
    tabsState.mode = windowDef.id;
    const { container } = render(tree());
    expect(residentIds(container).sort()).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
    ]);
  });

  it("a closed tab frees its place for the next most recent one", () => {
    const { container, rerender } = render(tree());
    for (const id of ["t2", "t3", "t4"]) {
      tabsState.focusedTabId = id;
      rerender(tree());
    }
    // Recency t4, t3, t2, t1: closing t3 lets t1 back in.
    tabsState.ids = ["t1", "t2", "t4", "t5"];
    rerender(tree());
    expect(residentIds(container).sort()).toEqual(["t1", "t2", "t4"]);
  });

  it("a window's Full screen keeps every window mounted for the way back", () => {
    tabsState.mode = windowDef.id;
    const { container, rerender } = render(tree());
    tabsState.mode = soloDef.id;
    tabsState.previousMode = windowDef.id;
    rerender(tree());
    expect(residentIds(container)).toHaveLength(5);

    // Leaving the desktop for good: the hidden-tab budget applies again.
    tabsState.mode = dockedDef.id;
    tabsState.previousMode = soloDef.id;
    rerender(tree());
    expect(residentIds(container)).toEqual(["t1"]);
  });
});
