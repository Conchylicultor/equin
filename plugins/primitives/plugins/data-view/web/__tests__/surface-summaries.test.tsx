import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { clause } from "@plugins/network/plugins/live/plugins/filter/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import type {
  DataViewSection,
  FieldDef,
  FilterGroup,
  FilterLowerContext,
  FilterOperatorSet,
  ViewState,
} from "../../core";
import { DataViewToolbar } from "../components/toolbar/data-view-toolbar";
import {
  DataViewControlsProvider,
  type DataViewControlsContextValue,
} from "../components/controls/controls-context";
import { SettingsControlPanel } from "../components/settings/settings-control-panel";
import { describeGroupBy } from "../components/settings/group-by-control";
import { GroupedSections } from "../internal/grouped-sections";
import { HiddenRowsFooter } from "../components/hidden-rows-footer";
import { DataViewSlots } from "../slots";

/**
 * Three surface options the commit pane's changed-files list is the first
 * consumer of: a promoted setting (Group by as a toolbar control of its own),
 * a section summary at rest in each group header, and the hidden-by-view
 * footer counting what the filter hides of what the search shows.
 */

afterEach(cleanup);

// ── promotedSettings ─────────────────────────────────────────────────────

function GroupByPanel() {
  return (
    <ControlPanel.Section label="Group by">
      <span>group-by panel</span>
    </ControlPanel.Section>
  );
}
function PropertiesPanel() {
  return (
    <ControlPanel.Section label="Properties">
      <span>properties panel</span>
    </ControlPanel.Section>
  );
}

const plugin = {
  id: "data-view-promoted-settings-test",
  description: "promoted settings fixture",
  contributions: [
    DataViewSlots.Setting({
      id: "data-view.group-by",
      scope: "view",
      component: GroupByPanel,
      promote: {
        label: "Group by",
        icon: symbol("stacks"),
        describe: describeGroupBy,
      },
    }),
    DataViewSlots.Setting({
      id: "data-view.properties",
      scope: "view",
      component: PropertiesPanel,
    }),
  ],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

const KIND_FIELD = {
  id: "kind",
  label: "Kind",
  type: "tag",
  value: (r: FileRow) => r.kind,
  options: [
    { value: "code", label: "Code" },
    { value: "test", label: "Tests" },
    { value: "doc", label: "Docs" },
  ],
} as unknown as FieldDef<unknown>;

function ctx(extra: Partial<DataViewControlsContextValue>) {
  return {
    storageKey: "test.promoted",
    promotedSettings: [],
    fields: [KIND_FIELD],
    activeState: { groupBy: { fieldId: "kind", groupingId: "value" } },
    ...extra,
  } as unknown as DataViewControlsContextValue;
}

function renderToolbar(extra: Partial<DataViewControlsContextValue>) {
  return render(
    <PluginProvider plugins={[plugin]}>
      <DataViewControlsProvider {...ctx(extra)}>
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

describe("promotedSettings", () => {
  it("draws nothing for a setting the surface did not promote", () => {
    renderToolbar({});
    expect(screen.queryByRole("button", { name: /^Group by/ })).toBeNull();
  });

  it("draws a promoted setting as a ghost trigger saying what it is set to", () => {
    renderToolbar({ promotedSettings: ["data-view.group-by"] });
    const trigger = screen.getByRole("button", { name: "Group by: Kind" });
    // Configuration, not narrowing: never the active `secondary` form.
    expect(trigger.className).not.toContain("bg-secondary");
    act(() => trigger.click());
    expect(screen.getByText("group-by panel")).toBeTruthy();
  });

  it("throws for an id no setting contributes, or one that cannot be promoted", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      renderToolbar({ promotedSettings: ["data-view.nope"] }),
    ).toThrow(/no DataViewSlots\.Setting contributes/);
    expect(() =>
      renderToolbar({ promotedSettings: ["data-view.properties"] }),
    ).toThrow(/declares no `promote`/);
  });

  it("leaves a promoted setting out of the View settings panel", () => {
    render(
      <PluginProvider plugins={[plugin]}>
        <DataViewControlsProvider
          {...ctx({ promotedSettings: ["data-view.group-by"] })}
        >
          <SettingsControlPanel />
        </DataViewControlsProvider>
      </PluginProvider>,
    );
    expect(screen.queryByText("group-by panel")).toBeNull();
    expect(screen.getByText("properties panel")).toBeTruthy();
  });
});

// ── sectionSummary ───────────────────────────────────────────────────────

const SECTIONS = [
  { key: "a", label: "Alpha", count: { kind: "exact", n: 2 }, entries: [] },
  { key: "b", label: "Beta", count: { kind: "exact", n: 1 }, entries: [] },
] as unknown as DataViewSection<unknown>[];

describe("sectionSummary", () => {
  it("draws each section's summary at rest, beside — not inside — the hover cluster", () => {
    render(
      <GroupedSections
        sections={SECTIONS}
        sectionSummary={(s) => (s.key === "a" ? "+12 −3" : null)}
        headerActions={() => <button type="button">act</button>}
      >
        {(section) => <div>rows of {section.key}</div>}
      </GroupedSections>,
    );
    const summaries = document.querySelectorAll(
      '[data-part="dv.group-summary"]',
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.textContent).toBe("+12 −3");
    // Never inside the hover-revealed action cluster.
    expect(summaries[0]!.closest("[data-row-actions]")).toBeNull();
  });

  it("publishes the offset under each section's header to its body", () => {
    render(
      <GroupedSections sections={SECTIONS}>
        {(section) => <div>rows of {section.key}</div>}
      </GroupedSections>,
    );
    for (const body of document.querySelectorAll<HTMLElement>(
      '[data-part="dv.group"]',
    )) {
      expect(body.style.getPropertyValue("--dv-section-offset")).toMatch(
        /^calc\(/,
      );
    }
  });
});

// ── revealHidden ─────────────────────────────────────────────────────────

type FileRow = { path: string; kind: string };

const ROWS: FileRow[] = [
  { path: "a.ts", kind: "code" },
  { path: "b.ts", kind: "code" },
  { path: "a.test.ts", kind: "test" },
  { path: "b.test.ts", kind: "test" },
  { path: "README.md", kind: "doc" },
];

const isOp: FilterOperatorSet = {
  match: "tag",
  domain: "text",
  operators: [
    {
      id: "is",
      label: "Is",
      hasValue: true,
      lower: (op: unknown, { column }: FilterLowerContext) =>
        typeof op === "string" ? clause(column, "eq", op) : undefined,
    },
  ],
} as unknown as FilterOperatorSet;

const codeOnly: FilterGroup = {
  kind: "group",
  id: "root",
  conjunction: "and",
  children: [
    { kind: "rule", id: "r", fieldId: "kind", operatorId: "is", value: "code" },
  ],
};

function renderFooter(state: Pick<ViewState, "query" | "filter">) {
  const onShow = vi.fn();
  render(
    <PluginProvider plugins={[]}>
      <HiddenRowsFooter
        rows={ROWS}
        fields={[KIND_FIELD]}
        state={state as ViewState}
        resolveOperatorSet={(type) => (type === "tag" ? isOp : undefined)}
        searchAccessor={(r) => (r as FileRow).path}
        onShow={onShow}
      />
    </PluginProvider>,
  );
  return onShow;
}

describe("revealHidden — HiddenRowsFooter", () => {
  it("counts the rows the filter hides and names their filtered values", () => {
    const onShow = renderFooter({ query: "", filter: codeOnly });
    const footer = screen.getByRole("button", { name: "Show 3 hidden rows" });
    expect(footer.textContent).toContain("3 hidden · tests, docs");
    act(() => footer.click());
    expect(onShow).toHaveBeenCalledOnce();
  });

  it("counts only what the search shows", () => {
    renderFooter({ query: ".test", filter: codeOnly });
    const footer = screen.getByRole("button", { name: "Show 2 hidden rows" });
    expect(footer.textContent).toContain("2 hidden · tests");
    expect(footer.textContent).not.toContain("docs");
  });

  it("draws nothing when the filter hides nothing", () => {
    renderFooter({ query: "", filter: null });
    expect(screen.queryByRole("button", { name: /hidden/ })).toBeNull();
  });
});
