import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  PARENT_FIELD_ID,
  type DataViewId,
  type DataViewRenderProps,
  type FieldDef,
  type Nesting,
  type SectionsToolbar,
  type ViewState,
} from "../../core";
import { DataViewSectionsBody } from "../components/data-view-body";
import { DataViewSlots, type DataViewContribution } from "../slots";
import type { ResolvedViewInstance } from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import type { ReadyViewModel } from "../internal/use-data-view-model";
import type { DataViewShellChrome } from "../internal/body-types";
import { fakeViewGetter } from "@plugins/primitives/plugins/data-view/plugins/view-core/web/testing";

/**
 * `ViewState.nesting` (Sub-items): a view that can nest draws a hierarchical
 * source as the tree (`nested`, default), every row flat with the derived
 * Parent field (`flat`), or only the top-level rows flat (`roots`). The host
 * hands the view `hierarchy` only while it nests; a view that never nests
 * ignores the key.
 */

type Row = { id: string; parent: string | null; title: string };
type ViewType = ResolvedViewInstance<DataViewContribution>["viewType"];

/** Prints what the host handed it: whether it nests, its rows, its fields. */
function ProbeView(props: DataViewRenderProps<unknown>) {
  const rows = props.rows as Row[];
  const parent = props.fields.find((f) => f.id === PARENT_FIELD_ID);
  return (
    <div>
      <p data-testid="nests">{props.hierarchy ? "nested" : "flat"}</p>
      <p data-testid="rows">{rows.map((r) => r.id).join(",")}</p>
      <p data-testid="fields">{props.fields.map((f) => f.id).join(",")}</p>
      <p data-testid="parents">
        {parent
          ? rows.map((r) => String(parent.value?.(r) ?? "-")).join(",")
          : ""}
      </p>
    </div>
  );
}

const nestingView = DataViewSlots.View({
  type: "nesting",
  title: "Nesting",
  icon: symbol("list"),
  nestsHierarchy: true,
  component: ProbeView,
}) as unknown as ViewType;
const listView = DataViewSlots.View({
  type: "list",
  title: "List",
  icon: symbol("list"),
  component: ProbeView,
}) as unknown as ViewType;

const plugin = {
  id: "data-view-nesting-test",
  description: "nesting fixture",
  contributions: [nestingView, listView],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

const NO_COLLAPSED: ReadonlySet<string> = new Set();
const NO_VARIANTS = new Map<string, never>();

function model(
  viewType: ViewType,
  nesting: Nesting | undefined,
): ReadyViewModel & { ready: true } {
  const state: ViewState = {
    sort: [],
    filter: null,
    nesting,
    properties: null,
    query: "",
    expanded: {},
  };
  const section = { hideWhenEmpty: false, description: null, collapsed: false };
  return {
    ready: true,
    instances: [
      {
        instance: {
          id: "v",
          name: "View",
          icon: symbol("list"),
          pickedIcon: null,
          type: (viewType as unknown as { type: string }).type,
        },
        viewType,
      },
    ],
    activeId: "v",
    setActiveView: () => {},
    stateFor: fakeViewGetter(() => state),
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
    sectionFor: fakeViewGetter(() => section),
    setViewCollapsed: () => {},
    actions: {
      availableSources: [],
      variantsFor: fakeViewGetter(() => NO_VARIANTS),
      addView: () => {},
      renameView: () => {},
      setViewIcon: () => {},
      duplicateView: () => {},
      deleteView: () => {},
      reorderView: () => {},
      updateView: () => {},
    },
  };
}

const titleField: FieldDef<Row> = {
  id: "title",
  label: "Title",
  type: "text",
  primary: true,
  value: (r) => r.title,
};

// a ─ a1 ─ a11;  b;  orphan (its parent "gone" is not loaded)
const ROWS: Row[] = [
  { id: "a", parent: null, title: "Alpha" },
  { id: "a1", parent: "a", title: "Alpha one" },
  { id: "a11", parent: "a1", title: "Alpha one one" },
  { id: "b", parent: null, title: "Beta" },
  { id: "orphan", parent: "gone", title: "Orphan" },
];

const SECTIONS: SectionsToolbar = { kind: "sections" };
const CHROME: DataViewShellChrome = {
  switcher: { strip: null, chip: null },
  switcherCount: 0,
  toolbar: SECTIONS,
  stickyRef: () => {},
};

function renderView(
  viewType: ViewType,
  nesting: Nesting | undefined,
  fields: FieldDef<Row>[] = [titleField],
) {
  const m = model(viewType, nesting);
  const { Wrapper } = createLiveStateHarness();
  render(
    <Wrapper>
      <PluginProvider plugins={[plugin]}>
        <DataViewSectionsBody<Row>
          storageKey={"nesting" as DataViewId}
          rows={ROWS}
          fields={fields}
          rowKey={(r) => r.id}
          hierarchy={{
            getParentId: (r) => r.parent,
            getRank: () => Rank.from("a0"),
          }}
          viewModel={m}
          instances={m.instances}
          chrome={CHROME}
        />
      </PluginProvider>
    </Wrapper>,
  );
  const text = (id: string) => screen.getByTestId(id).textContent;
  return {
    nests: text("nests"),
    rows: text("rows"),
    fields: text("fields"),
    parents: text("parents"),
  };
}

afterEach(cleanup);

describe("nesting (Sub-items)", () => {
  it("nests by default: the view gets the hierarchy and no Parent field", () => {
    const out = renderView(nestingView, undefined);
    expect(out.nests).toBe("nested");
    expect(out.rows).toBe("a,a1,a11,b,orphan");
    expect(out.fields).toBe("title");
  });

  it("flat: every row, no hierarchy, and a Parent field labelled by the parent's primary field", () => {
    const out = renderView(nestingView, "flat");
    expect(out.nests).toBe("flat");
    expect(out.rows).toBe("a,a1,a11,b,orphan");
    expect(out.fields).toBe(`title,${PARENT_FIELD_ID}`);
    // A root has none; a parent outside the rows shows its id.
    expect(out.parents).toBe("-,Alpha,Alpha one,-,gone");
  });

  it("roots: only the top-level rows (an orphan counts), flat, with no Parent field", () => {
    const out = renderView(nestingView, "roots");
    expect(out.nests).toBe("flat");
    expect(out.rows).toBe("a,b,orphan");
    expect(out.fields).toBe("title");
  });

  it("a view type that never nests ignores the key", () => {
    const out = renderView(listView, "roots");
    expect(out.nests).toBe("flat");
    expect(out.rows).toBe("a,a1,a11,b,orphan");
    expect(out.fields).toBe("title");
  });
});
