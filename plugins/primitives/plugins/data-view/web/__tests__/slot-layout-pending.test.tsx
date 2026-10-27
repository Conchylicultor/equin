/**
 * A slot's layout not known yet is a state, never an empty list. Every place a
 * DataView reads a slot in its layout order (`useSlotOrder`) answers it:
 *
 * - the host (`DataView`) shows the shell's own placeholder and never builds
 *   its view model over a stand-in empty list of view types — that would
 *   report every configured row as an orphan type;
 * - the settings panel shows a loading state, never "Nothing to configure";
 * - the toolbar draws no control triggers and no badge count;
 * - a failed layout with none ever known is that failure, with Retry; one
 *   with a last-known layout draws by it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const buildModel = vi.fn();
vi.mock("../internal/use-data-view-model", () => ({
  useDataViewModel: (...args: unknown[]) => buildModel(...args) as unknown,
}));

import { cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type Contribution,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { SlotRender } from "@plugins/primitives/plugins/slot-render/web";
import {
  ResourceError,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { DataViewId } from "../../core";
import { DataView } from "../components/data-view";
import { DataViewToolbar } from "../components/toolbar/data-view-toolbar";
import { SettingsControlPanel } from "../components/settings/settings-control-panel";
import {
  DataViewControlsProvider,
  type DataViewControlsContextValue,
} from "../components/controls/controls-context";
import { expandAllAction } from "../components/settings/expand-all";
import { DataViewSlots } from "../slots";

afterEach(() => {
  cleanup();
  buildModel.mockReset();
  order.current = null;
});

type Order = ResourceResult<readonly Contribution[]>;
const refetch = () => Promise.resolve();
const LOADING: Order = { status: "loading", refetch };
const FAILED: Order = {
  status: "error",
  error: new ResourceError("loader-failed", "layout read failed", null),
  refetch,
};

/** The layout every slot answers with; `null` → its registration order. */
const order = { current: null as Order | null };

function plugin(contributions: unknown[]): LoadedPlugin {
  return {
    id: "data-view-slot-layout-pending-test",
    description: "a layout engine whose orders are still loading",
    contributions: [
      ...contributions,
      SlotRender.Order({
        useOrder: (_slot, items) =>
          order.current ?? { status: "ready", data: items, refetch },
      }),
    ],
    slots: { ...DataViewSlots, ...SlotRender },
  } as unknown as LoadedPlugin;
}

const VIEW = DataViewSlots.View({
  type: "list",
  title: "List",
  icon: symbol("list"),
  component: () => null,
});

function mountDataView() {
  return render(
    <PluginProvider plugins={[plugin([VIEW])]}>
      <DataView
        storageKey={"test-layout-pending" as DataViewId}
        rows={[]}
        fields={[]}
        rowKey={(_r: unknown, i: number) => String(i)}
      />
    </PluginProvider>,
  );
}

describe("DataView while its view types' layout is not known", () => {
  it("shows the shell placeholder and builds no model", () => {
    order.current = LOADING;
    mountDataView();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText(/No views configured/)).toBeNull();
    expect(buildModel).not.toHaveBeenCalled();
  });

  it("shows the failure, with Retry, when none was ever known", () => {
    order.current = FAILED;
    mountDataView();
    expect(screen.getByText(/layout read failed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(buildModel).not.toHaveBeenCalled();
  });

  it("builds the model over the last-known layout of a failed read", () => {
    order.current = { ...FAILED, stale: [] } as Order;
    buildModel.mockReturnValue({ ready: false, failure: null });
    mountDataView();
    expect(buildModel).toHaveBeenCalled();
  });
});

function ctx(extra: Partial<DataViewControlsContextValue> = {}) {
  return { expandAll: null, ...extra } as DataViewControlsContextValue;
}

describe("settings panel while the settings' layout is not known", () => {
  it("shows a loading state, never 'Nothing to configure'", () => {
    order.current = LOADING;
    render(
      <PluginProvider plugins={[plugin([])]}>
        <DataViewControlsProvider {...ctx()}>
          <SettingsControlPanel />
        </DataViewControlsProvider>
      </PluginProvider>,
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText(/Nothing to configure/)).toBeNull();
  });

  it("says there is nothing to configure once known and empty", () => {
    render(
      <PluginProvider plugins={[plugin([])]}>
        <DataViewControlsProvider {...ctx()}>
          <SettingsControlPanel />
        </DataViewControlsProvider>
      </PluginProvider>,
    );
    expect(screen.getByText(/Nothing to configure/)).toBeTruthy();
  });
});

const FILTER = DataViewSlots.Control({
  id: "test.filter",
  label: "Filter",
  icon: symbol("filter-list"),
  summary: () => ({ label: "Status is done", count: 2 }),
  component: () => null,
});
const EXPAND = DataViewSlots.Control({
  id: "data-view.expand-all",
  action: expandAllAction,
});

function mountToolbar(density?: "compact") {
  return render(
    <PluginProvider plugins={[plugin([FILTER, EXPAND])]}>
      <DataViewControlsProvider
        {...ctx({ expandAll: { allExpanded: false, setAll: () => {} } })}
      >
        <DataViewToolbar
          query=""
          onQueryChange={() => {}}
          switcher={{ strip: <div />, chip: <div /> }}
          switcherCount={1}
          {...(density ? { density } : {})}
        />
      </DataViewControlsProvider>
    </PluginProvider>,
  );
}

describe("toolbar while the controls' layout is not known", () => {
  it("draws no control triggers", () => {
    order.current = LOADING;
    mountToolbar();
    expect(screen.queryByRole("button", { name: "Expand all" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Filter/ })).toBeNull();
  });

  it("draws them once known", () => {
    mountToolbar();
    expect(screen.getByRole("button", { name: "Expand all" })).toBeTruthy();
  });

  it("shows no count badge on the compact trigger", () => {
    order.current = LOADING;
    mountToolbar("compact");
    const trigger = screen.getByRole("button", { name: "View options" });
    expect(trigger.textContent).not.toContain("2");
  });

  it("shows the count once known", () => {
    mountToolbar("compact");
    const trigger = screen.getByRole("button", { name: "View options" });
    expect(trigger.textContent).toContain("2");
  });
});
