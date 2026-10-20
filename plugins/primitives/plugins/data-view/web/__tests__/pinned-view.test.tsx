import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type { DataViewId } from "../../core";
import { DataViewShellFrame } from "../components/data-view";
import type {
  ReadyViewModel,
  ViewModel,
} from "../internal/use-data-view-model";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { fakeViewGetter } from "@plugins/primitives/plugins/data-view/plugins/view-core/web/testing";

const NO_COLLAPSED: ReadonlySet<string> = new Set();
const STATE = {
  sort: [],
  filter: null,
  properties: null,
  groupBy: undefined,
  query: "",
  expanded: {},
};

const LIST_ICON = symbol("view-list");

/**
 * The pinned-instance contract, at the seam where it was nearly lost.
 *
 * `resolveActiveId` answers a pinned id that is not authored with `""` (proved
 * in its own suite, beside it). This asserts the other half: that the SHELL
 * renders that as "not authored" rather than falling through to `instances[0]`.
 * The fallback is correct for an unpinned surface and catastrophic for a pinned
 * one — a mis-pinned backup panel silently rendering the Active tab is a
 * different list that looks like a working one — and it is invisible on any
 * surface that has instances at all, which is every real surface.
 */

const plugin = {
  id: "data-view-pinned-view-test",
  description: "pinned-view shell fixture",
  contributions: [],
} as unknown as LoadedPlugin;

const STORAGE_KEY = "runs" as DataViewId;

function inst(id: string) {
  return {
    instance: { id, name: id, icon: LIST_ICON, pickedIcon: null, type: "list" },
    viewType: {},
  };
}

/** Three authored instances — the shape `config/runs/runs.jsonc` has. */
const INSTANCES = [inst("active"), inst("recent"), inst("backups")];

/**
 * A settled model. `activeId` is what `resolveActiveId` would have produced:
 * the pinned id when it is authored, `""` when it is not, and the persisted /
 * first instance when the surface is not pinned.
 */
function model(activeId: string): ViewModel {
  return {
    ready: true,
    instances: INSTANCES,
    activeId,
    setActiveView: () => {},
    stateFor: fakeViewGetter(() => STATE),
    setSort: () => {},
    setSortRules: () => {},
    setProperties: () => {},
    setFilter: () => {},
    setGroupBy: () => {},
    setFold: () => {},
    setQuery: () => {},
    setExpanded: () => {},
    collapsedSectionsFor: fakeViewGetter(() => NO_COLLAPSED),
    setSectionCollapsed: () => {},
    actions: {
      availableSources: [],
      addView: () => {},
      renameView: () => {},
      setViewIcon: () => {},
      duplicateView: () => {},
      deleteView: () => {},
      reorderView: () => {},
      updateView: () => {},
    },
  } as unknown as ReadyViewModel & { ready: true };
}

let lastSwitcher: unknown;

function renderShell(opts: { activeId: string; pinnedView?: string }) {
  lastSwitcher = undefined;
  return render(
    <PluginProvider plugins={[plugin]}>
      <DataViewShellFrame
        storageKey={STORAGE_KEY}
        viewModel={model(opts.activeId)}
        pinnedView={opts.pinnedView}
      >
        {(activeInstance, chrome) => {
          lastSwitcher = chrome.switcher;
          return (
            <div data-testid="body">rows of {activeInstance.instance.id}</div>
          );
        }}
      </DataViewShellFrame>
    </PluginProvider>,
  );
}

afterEach(cleanup);

describe("pinnedView", () => {
  it("renders the placeholder — not the first instance — when the pinned id is not authored", () => {
    renderShell({ activeId: "", pinnedView: "backup" });

    // It says which id it could not find, so a typo is readable rather than
    // "why is the backup panel showing builds".
    expect(screen.getByText(/backup/)).toBeTruthy();
    expect(screen.getByText(/No view instance/)).toBeTruthy();
    // The body never mounted: no rows, and certainly not `active`'s.
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("renders the pinned instance, and no switcher, when it IS authored", () => {
    renderShell({ activeId: "backups", pinnedView: "backups" });

    expect(screen.getByTestId("body").textContent).toBe("rows of backups");
    // The node itself, not merely a count of 1: the WIDE toolbar renders the
    // switcher unconditionally, so a non-null node would paint a live tab strip
    // whose clicks this host ignores.
    expect(lastSwitcher).toEqual({ strip: null, chip: null });
  });

  it("keeps the first-instance fallback for an UNPINNED surface", () => {
    renderShell({ activeId: "gone" });

    expect(screen.getByTestId("body").textContent).toBe("rows of active");
    expect(lastSwitcher).toMatchObject({
      strip: expect.anything(),
      chip: expect.anything(),
    });
  });

  it("still says 'no views configured' for an unpinned surface with none", () => {
    render(
      <PluginProvider plugins={[plugin]}>
        <DataViewShellFrame
          storageKey={STORAGE_KEY}
          viewModel={{ ...model(""), instances: [] } as unknown as ViewModel}
        >
          {() => <div data-testid="body">rows</div>}
        </DataViewShellFrame>
      </PluginProvider>,
    );

    expect(screen.getByText(/No views configured/)).toBeTruthy();
    expect(screen.queryByTestId("body")).toBeNull();
  });
});

describe("unavailable", () => {
  it("renders the read's message in place of every instance, keeping the title", () => {
    render(
      <PluginProvider plugins={[plugin]}>
        <DataViewShellFrame
          storageKey={STORAGE_KEY}
          viewModel={model("active")}
          title="Automations"
          unavailable="Automations isn't available in this version of the app."
        >
          {() => <div data-testid="body">rows</div>}
        </DataViewShellFrame>
      </PluginProvider>,
    );

    expect(screen.getByText(/isn't available/)).toBeTruthy();
    expect(screen.getByText("Automations")).toBeTruthy();
    // No body — so no view, no search box over rows that will never arrive.
    expect(screen.queryByTestId("body")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});
