import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { DataViewToolbar } from "../components/toolbar/data-view-toolbar";
import { CompactRootPanel } from "../components/toolbar/compact-controls";
import { useToolbarControls } from "../components/toolbar/use-toolbar-controls";
import {
  DataViewControlsProvider,
  type DataViewControlsContextValue,
  type DataViewExpandAll,
} from "../components/controls/controls-context";
import {
  ExpandAllSetting,
  expandAllAction,
} from "../components/settings/expand-all";
import { DataViewSlots } from "../slots";

/**
 * The expand-all as a toolbar control: an ACTION control over the controls
 * context's `expandAll` (the capability the active view reports up) — a ghost
 * icon among the tools whose label follows the state, no trigger at all
 * without the capability, a plain row in the compact fold, and the view
 * settings' Expand all / Collapse all rows.
 */

const plugin = {
  id: "data-view-expand-all-test",
  description: "expand-all control fixture",
  contributions: [
    DataViewSlots.Control({
      id: "data-view.expand-all",
      action: expandAllAction,
    }),
  ],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

function ctx(expandAll: DataViewExpandAll | null) {
  return { expandAll } as DataViewControlsContextValue;
}

function renderToolbar(expandAll: DataViewExpandAll | null) {
  return render(
    <PluginProvider plugins={[plugin]}>
      <DataViewControlsProvider {...ctx(expandAll)}>
        <DataViewToolbar
          query=""
          onQueryChange={() => {}}
          switcher={{ strip: <div />, chip: <div /> }}
          switcherCount={1}
        />
      </DataViewControlsProvider>
    </PluginProvider>,
  );
}

function FoldPanel() {
  const { controls } = useToolbarControls();
  return <CompactRootPanel controls={controls} />;
}

afterEach(cleanup);

describe("expand-all toolbar control", () => {
  it("draws a ghost icon in the tools that expands everything", () => {
    const setAll = vi.fn();
    renderToolbar({ allExpanded: false, setAll });
    const tools = screen.getByRole("group", { name: "Tools" });
    const button = screen.getByRole("button", { name: "Expand all" });
    expect(tools.contains(button)).toBe(true);
    fireEvent.click(button);
    expect(setAll).toHaveBeenCalledWith(true);
  });

  it("says Collapse all once every row is open, and folds them", () => {
    const setAll = vi.fn();
    renderToolbar({ allExpanded: true, setAll });
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(setAll).toHaveBeenCalledWith(false);
  });

  it("draws nothing while the active view reports nothing to fold", () => {
    renderToolbar(null);
    expect(
      screen.queryByRole("button", { name: /expand all|collapse all/i }),
    ).toBeNull();
  });

  it("is a plain row in the compact fold", () => {
    const setAll = vi.fn();
    render(
      <PluginProvider plugins={[plugin]}>
        <DataViewControlsProvider {...ctx({ allExpanded: false, setAll })}>
          <FoldPanel />
        </DataViewControlsProvider>
      </PluginProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(setAll).toHaveBeenCalledWith(true);
  });
});

describe("expand-all view setting", () => {
  it("offers both Expand all and Collapse all", () => {
    const setAll = vi.fn();
    render(
      <DataViewControlsProvider {...ctx({ allExpanded: false, setAll })}>
        <ExpandAllSetting />
      </DataViewControlsProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(setAll).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(setAll).toHaveBeenLastCalledWith(false);
  });
});
