import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { clause } from "@plugins/network/plugins/live/plugins/filter/core";
import type { ResourceReadiness } from "@plugins/primitives/plugins/live-state/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type {
  CreateOption,
  DataViewId,
  DataViewRenderProps,
  FieldDef,
  FilterGroup,
  SectionsToolbar,
  ViewState,
} from "../../core";
import { DataViewShellFrame } from "../components/data-view";
import { DataViewSectionsBody } from "../components/data-view-body";
import { DataViewSlots, type DataViewContribution } from "../slots";
import type { ResolvedViewInstance } from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import type {
  ReadyViewModel,
  SectionPresentation,
  ViewModel,
} from "../internal/use-data-view-model";
import type { DataViewShellChrome } from "../internal/body-types";
import { useViewEphemeral } from "../internal/use-view-ephemeral";
import { fakeViewGetter } from "@plugins/primitives/plugins/data-view/plugins/view-core/web/testing";

const LIST_ICON = symbol("view-list");

/**
 * The `{ kind: "sections" }` chrome: every authored instance renders, stacked,
 * each under its own collapsible header — no switcher, no active instance.
 */

type Row = { id: string; parent: string | null; tag: string };

/** A registered view-type, as a resolved instance carries it (sealed). */
type ViewType = ResolvedViewInstance<DataViewContribution>["viewType"];

/** A minimal view: one line per row it was handed, so a test reads the rows. */
function RowsView(props: DataViewRenderProps<unknown>) {
  const rows = props.rows as Row[];
  return (
    <ul>
      {rows.map((r) => (
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
/** A view that nests its rows over the hierarchical source (as the table does). */
const nestedView = DataViewSlots.View({
  type: "nested",
  title: "Nested",
  icon: symbol("list"),
  nestsHierarchy: true,
  component: RowsView,
}) as unknown as ViewType;

const plugin = {
  id: "data-view-sections-toolbar-test",
  description: "sections toolbar fixture",
  contributions: [
    listView,
    nestedView,
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

const STORAGE_KEY = "sections" as DataViewId;
const SECTIONS: SectionsToolbar = { kind: "sections" };

const tagIs = (tag: string): FilterGroup => ({
  kind: "group",
  id: "root",
  conjunction: "and",
  children: [
    {
      kind: "rule",
      id: "r",
      fieldId: "tag",
      operatorId: "contains",
      value: tag,
    },
  ],
});

interface InstanceSpec {
  id: string;
  name: string;
  tree?: boolean;
  filter?: FilterGroup;
  filterScope?: ViewState["filterScope"];
  presentation?: Partial<SectionPresentation>;
}

function instance(spec: InstanceSpec) {
  return {
    instance: {
      id: spec.id,
      name: spec.name,
      icon: LIST_ICON,
      pickedIcon: null,
      type: spec.tree ? "nested" : "list",
    },
    viewType: spec.tree ? nestedView : listView,
  };
}

const NO_COLLAPSED: ReadonlySet<string> = new Set();
const NO_VARIANTS = new Map<string, never>();

function model(
  specs: InstanceSpec[],
  spies: { setViewCollapsed?: (id: string, c: boolean) => void } = {},
): ReadyViewModel & { ready: true } {
  // One stored state / presentation per view, like the real getters.
  const states = new Map(
    specs.map((s): [string, ViewState] => [
      s.id,
      {
        sort: [],
        filter: s.filter ?? null,
        filterScope: s.filterScope,
        visibleFields: null,
        query: "",
        expanded: {},
      },
    ]),
  );
  const sections = new Map(
    specs.map((s): [string, SectionPresentation] => [
      s.id,
      {
        hideWhenEmpty: false,
        description: null,
        collapsed: false,
        ...s.presentation,
      },
    ]),
  );
  return {
    ready: true,
    instances: specs.map(instance),
    activeId: specs[0]?.id ?? "",
    setActiveView: () => {},
    stateFor: fakeViewGetter((id) => states.get(id)!),
    setSort: () => {},
    setSortRules: () => {},
    setVisibleFields: () => {},
    setFilter: () => {},
    setGroupBy: () => {},
    setFold: () => {},
    setQuery: () => {},
    setExpanded: () => {},
    collapsedSectionsFor: fakeViewGetter(() => NO_COLLAPSED),
    setSectionCollapsed: () => {},
    sectionFor: fakeViewGetter((id) => sections.get(id)!),
    setViewCollapsed: spies.setViewCollapsed ?? (() => {}),
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

// a (user) ─ a1 (agent);  b (agent) ─ b1 (user)
const ROWS: Row[] = [
  { id: "a", parent: null, tag: "user" },
  { id: "a1", parent: "a", tag: "agent" },
  { id: "b", parent: null, tag: "agent" },
  { id: "b1", parent: "b", tag: "user" },
];

const CHROME: DataViewShellChrome = {
  switcher: { strip: null, chip: null },
  switcherCount: 0,
  toolbar: SECTIONS,
  stickyRef: () => {},
};

function renderSections(opts: {
  specs: InstanceSpec[];
  rows?: Row[];
  readiness?: ResourceReadiness;
  creators?: CreateOption[];
  setViewCollapsed?: (id: string, c: boolean) => void;
}) {
  const m = model(opts.specs, { setViewCollapsed: opts.setViewCollapsed });
  const { Wrapper } = createLiveStateHarness();
  return render(
    // The app root always mounts the live-state provider; the body reads
    // through it (its live-source hook) even for in-memory rows.
    <Wrapper>
      <PluginProvider plugins={[plugin]}>
        <DataViewSectionsBody<Row>
          storageKey={STORAGE_KEY}
          rows={opts.rows ?? ROWS}
          fields={fields}
          rowKey={(r) => r.id}
          hierarchy={{
            getParentId: (r) => r.parent,
            getRank: () => Rank.from("a0"),
          }}
          readiness={opts.readiness}
          creators={opts.creators}
          viewModel={m}
          instances={m.instances}
          chrome={CHROME}
        />
      </PluginProvider>
    </Wrapper>,
  );
}

const header = (name: string) =>
  screen.queryByRole("button", { name: new RegExp(`^${name}`) });

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("sections toolbar — shell", () => {
  it("hands EVERY instance to the sections renderer, never the one-instance child", () => {
    const m = model([
      { id: "favorites", name: "Favorites" },
      { id: "pages", name: "Private" },
    ]);
    const child = vi.fn(() => <div>active body</div>);
    render(
      <PluginProvider plugins={[plugin]}>
        <DataViewShellFrame
          storageKey={STORAGE_KEY}
          viewModel={m as ViewModel}
          toolbar={SECTIONS}
          renderSections={(instances) => (
            <div data-testid="sections">
              {instances.map((i) => i.instance.id).join(",")}
            </div>
          )}
        >
          {child}
        </DataViewShellFrame>
      </PluginProvider>,
    );
    expect(screen.getByTestId("sections").textContent).toBe("favorites,pages");
    expect(child).not.toHaveBeenCalled();
  });
});

describe("sections toolbar — body", () => {
  it("renders every instance under its own header, each with its own rows", () => {
    renderSections({
      specs: [
        { id: "pages", name: "Private", filter: tagIs("user") },
        { id: "scratch", name: "Scratch", filter: tagIs("agent") },
      ],
    });
    expect(header("Private")).toBeTruthy();
    expect(header("Scratch")).toBeTruthy();
    // Each section's body is its own view over the rows (this fixture view
    // prints what it was handed — the flat filter is the view's own job).
    expect(screen.getAllByText("a")).toHaveLength(2);
  });

  it("the header toggles the view-level collapse, and a collapsed section hides its body", () => {
    const setViewCollapsed = vi.fn();
    renderSections({
      specs: [
        { id: "pages", name: "Private" },
        { id: "scratch", name: "Scratch", presentation: { collapsed: true } },
      ],
      setViewCollapsed,
    });
    // Only Private's body is mounted.
    expect(screen.getAllByText("a")).toHaveLength(1);
    fireEvent.click(header("Private")!);
    expect(setViewCollapsed).toHaveBeenCalledWith("pages", true);
    fireEvent.click(header("Scratch")!);
    expect(setViewCollapsed).toHaveBeenCalledWith("scratch", false);
  });

  it("hideWhenEmpty: a section whose view has no rows is not rendered at all", () => {
    renderSections({
      specs: [
        { id: "pages", name: "Private" },
        {
          id: "favorites",
          name: "Favorites",
          filter: tagIs("starred"),
          presentation: { hideWhenEmpty: true },
        },
      ],
    });
    expect(header("Private")).toBeTruthy();
    expect(header("Favorites")).toBeNull();
  });

  it("hideWhenEmpty: shown once any row survives the filter", () => {
    renderSections({
      specs: [
        {
          id: "scratch",
          name: "Scratch",
          filter: tagIs("agent"),
          presentation: { hideWhenEmpty: true },
        },
      ],
    });
    expect(header("Scratch")).toBeTruthy();
  });

  it("hideWhenEmpty: never painted while the rows are still loading", () => {
    renderSections({
      specs: [
        { id: "pages", name: "Private" },
        {
          id: "scratch",
          name: "Scratch",
          presentation: { hideWhenEmpty: true },
        },
      ],
      readiness: { status: "loading" } as ResourceReadiness,
    });
    // The unconditional section shows its loading state; the hide-when-empty
    // one is absent — "not known yet" is never painted as an empty section.
    expect(header("Private")).toBeTruthy();
    expect(header("Scratch")).toBeNull();
  });

  it("hideWhenEmpty on a roots-scoped tree tests ROOTS: a matching child of a non-matching root does not count", () => {
    renderSections({
      specs: [
        {
          id: "scratch",
          name: "Scratch",
          tree: true,
          filter: tagIs("agent"),
          filterScope: "roots",
          presentation: { hideWhenEmpty: true },
        },
      ],
      // Only `a1` is agent, and its root `a` is not.
      rows: [
        { id: "a", parent: null, tag: "user" },
        { id: "a1", parent: "a", tag: "agent" },
      ],
    });
    expect(header("Scratch")).toBeNull();
  });

  it("a creator's `views` narrows which section headers offer it", () => {
    renderSections({
      specs: [
        { id: "favorites", name: "Favorites" },
        { id: "pages", name: "Private" },
      ],
      creators: [
        {
          id: "new-page",
          label: "New page",
          views: ["pages"],
          onSelect: () => {},
        },
      ],
    });
    // One `+`, and it sits in Private's header.
    const plus = screen.getAllByRole("button", { name: "New page" });
    expect(plus).toHaveLength(1);
    const privateHeader = header("Private")!.closest(".sticky")!;
    expect(privateHeader.contains(plus[0]!)).toBe(true);
  });

  it("the description rides the header as a tooltip, not a second line", () => {
    renderSections({
      specs: [
        {
          id: "scratch",
          name: "Scratch",
          presentation: { description: "Pages created by agent runs" },
        },
      ],
    });
    expect(header("Scratch")).toBeTruthy();
    expect(screen.queryByText("Pages created by agent runs")).toBeNull();
  });
});

describe("sections toolbar — collapse persistence", () => {
  it("a view's section collapse survives a remount (device-local)", () => {
    const first = renderHook(() => useViewEphemeral(STORAGE_KEY));
    expect(first.result.current.localFor("pages").collapsed).toBe(false);
    act(() => first.result.current.setViewCollapsed("pages", true));
    expect(first.result.current.localFor("pages").collapsed).toBe(true);
    first.unmount();

    const second = renderHook(() => useViewEphemeral(STORAGE_KEY));
    expect(second.result.current.localFor("pages").collapsed).toBe(true);
    // A view-level flag, never mixed into the group-by keys.
    expect(second.result.current.localFor("pages").collapsedSections).toEqual(
      [],
    );
    expect(second.result.current.localFor("scratch").collapsed).toBe(false);
  });
});
