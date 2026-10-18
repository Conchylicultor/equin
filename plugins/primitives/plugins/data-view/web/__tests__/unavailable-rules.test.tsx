import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import {
  markDeferredLoadComplete,
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { clause } from "@plugins/network/plugins/live/plugins/filter/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type {
  DataViewId,
  DataViewRenderProps,
  FieldDef,
  FilterGroup,
  FilterRule,
  FoldRule,
  SectionsToolbar,
  ViewState,
} from "../../core";
import { DataViewSectionsBody } from "../components/data-view-body";
import { DataViewSlots, type DataViewContribution } from "../slots";
import type { ResolvedViewInstance } from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import type {
  ReadyViewModel,
  SectionPresentation,
} from "../internal/use-data-view-model";
import type { DataViewShellChrome } from "../internal/body-types";
import { fakeViewGetter } from "@plugins/primitives/plugins/data-view/plugins/view-core/web/testing";

/**
 * A saved filter / fold rule whose field or operator never resolves (a deleted
 * custom column, a renamed field id), once the deferred plugin tier has
 * loaded: the in-memory body renders the rule error with Remove — never the
 * rows the rule would have hidden — and Remove writes the pruned tree back.
 */

// Every plugin has loaded: an unresolved rule is no longer "not yet".
beforeAll(() => markDeferredLoadComplete());

type Row = { id: string; tag: string };
type ViewType = ResolvedViewInstance<DataViewContribution>["viewType"];

/** One line per row the view was handed, so a test can see whether it rendered. */
function RowsView(props: DataViewRenderProps<unknown>) {
  return (
    <ul>
      {(props.rows as Row[]).map((r) => (
        <li key={r.id}>{r.id}</li>
      ))}
    </ul>
  );
}

const listView = DataViewSlots.View({
  type: "list",
  title: "List",
  icon: symbol("list"),
  component: RowsView,
}) as unknown as ViewType;

const plugin = {
  id: "data-view-unavailable-rules-test",
  description: "unavailable filter rules fixture",
  contributions: [
    listView,
    DataViewSlots.Filter({
      match: "tag",
      domain: "text",
      operators: [
        {
          id: "contains",
          label: "Contains",
          hasValue: true,
          lower: (op, { column }) =>
            typeof op === "string" && op !== ""
              ? clause(column, "contains", op)
              : undefined,
        },
      ],
    }),
  ],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

const rule = (id: string, fieldId: string, value: string): FilterRule => ({
  kind: "rule",
  id,
  fieldId,
  operatorId: "contains",
  value,
});
const and = (...children: FilterRule[]): FilterGroup => ({
  kind: "group",
  id: "root",
  conjunction: "and",
  children,
});

const fields: FieldDef<Row>[] = [
  {
    id: "label",
    label: "Label",
    type: "plain",
    primary: true,
    value: (r) => r.id,
  },
  { id: "tag", label: "Tag", type: "tag", value: (r) => r.tag },
];
const ROWS: Row[] = [
  { id: "a", tag: "user" },
  { id: "b", tag: "agent" },
];

const CHROME: DataViewShellChrome = {
  switcher: { strip: null, chip: null },
  switcherCount: 0,
  toolbar: { kind: "sections" } satisfies SectionsToolbar,
  stickyRef: () => {},
};

function renderView(opts: {
  filter?: FilterGroup;
  fold?: FoldRule;
  hideWhenEmpty?: boolean;
}) {
  const setFilter = vi.fn();
  const setFold = vi.fn();
  const state: ViewState = {
    sort: [],
    filter: opts.filter ?? null,
    ...(opts.fold ? { fold: opts.fold } : {}),
    properties: null,
    query: "",
    expanded: {},
  };
  const presentation: SectionPresentation = {
    hideWhenEmpty: opts.hideWhenEmpty ?? false,
    description: null,
    collapsed: false,
  };
  const instances = [
    {
      instance: {
        id: "favorites",
        name: "Favorites",
        icon: symbol("view-list"),
        pickedIcon: null,
        type: "list",
      },
      viewType: listView,
    },
  ];
  const model = {
    ready: true,
    instances,
    activeId: "favorites",
    setActiveView: () => {},
    stateFor: fakeViewGetter(() => state),
    setSort: () => {},
    setSortRules: () => {},
    setVisibleFields: () => {},
    setFilter,
    setGroupBy: () => {},
    setFold,
    setQuery: () => {},
    setExpanded: () => {},
    collapsedSectionsFor: fakeViewGetter(() => new Set<string>()),
    setSectionCollapsed: () => {},
    sectionFor: fakeViewGetter(() => presentation),
    setViewCollapsed: () => {},
    actions: {
      availableSources: [],
      variantsFor: fakeViewGetter(() => new Map<string, never>()),
      addView: () => {},
      renameView: () => {},
      setViewIcon: () => {},
      duplicateView: () => {},
      deleteView: () => {},
      reorderView: () => {},
      updateView: () => {},
    },
  } as unknown as ReadyViewModel & { ready: true };
  const { Wrapper } = createLiveStateHarness();
  render(
    <Wrapper>
      <PluginProvider plugins={[plugin]}>
        <DataViewSectionsBody<Row>
          storageKey={"unavailable-rules" as DataViewId}
          rows={ROWS}
          fields={fields}
          rowKey={(r) => r.id}
          viewModel={model}
          instances={model.instances}
          chrome={CHROME}
        />
      </PluginProvider>
    </Wrapper>,
  );
  return { setFilter, setFold };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("an unavailable filter rule, once every plugin loaded", () => {
  it("renders the rule error in place of the rows, never every row", () => {
    renderView({ filter: and(rule("gone", "deleted-column", "x")) });
    expect(
      screen.getByText(/This view filters on "deleted-column"/),
    ).toBeTruthy();
    expect(screen.queryByText("a")).toBeNull();
    expect(screen.queryByText("b")).toBeNull();
  });

  it("Remove drops only the unavailable rule and saves the filter", () => {
    const { setFilter } = renderView({
      filter: and(
        rule("kept", "tag", "user"),
        rule("gone", "deleted-column", "x"),
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
    expect(setFilter).toHaveBeenCalledWith(
      "favorites",
      and(rule("kept", "tag", "user")),
    );
  });

  it("Remove clears the filter when no rule is left", () => {
    const { setFilter } = renderView({
      filter: and(rule("gone", "deleted-column", "x")),
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
    expect(setFilter).toHaveBeenCalledWith("favorites", null);
  });

  it("a hideWhenEmpty section shows the error — neither hidden nor listing everything", () => {
    renderView({
      filter: and(rule("gone", "deleted-column", "x")),
      hideWhenEmpty: true,
    });
    expect(screen.getByRole("button", { name: /^Favorites/ })).toBeTruthy();
    expect(
      screen.getByText(/This view filters on "deleted-column"/),
    ).toBeTruthy();
    expect(screen.queryByText("a")).toBeNull();
  });
});

describe("an unavailable fold rule", () => {
  it("renders the rule error instead of folding nothing, and Remove clears the fold", () => {
    const { setFold } = renderView({
      fold: { keep: and(rule("gone", "deleted-column", "x")) },
    });
    expect(
      screen.getByText(/This view folds on "deleted-column"/),
    ).toBeTruthy();
    expect(screen.queryByText("a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
    expect(setFold).toHaveBeenCalledWith("favorites", null);
  });
});
