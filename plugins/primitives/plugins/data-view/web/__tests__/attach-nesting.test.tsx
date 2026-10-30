import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type {
  DataViewAttachConfig,
  DataViewId,
  DataViewPaging,
  DataViewRenderProps,
  FieldDef,
  Nesting,
  SectionsToolbar,
  ViewState,
} from "../../core";
import { DataViewSectionsBody } from "../components/data-view-body";
import { DataViewSlots, type DataViewContribution } from "../slots";
import type { ResolvedViewInstance } from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import type { ReadyViewModel } from "../internal/use-data-view-model";
import type { DataViewShellChrome } from "../internal/body-types";
import { fakeViewGetter } from "@plugins/primitives/plugins/data-view/plugins/view-core/web/testing";
import { consumerPaging } from "../testing";

/**
 * `attach` under the Sub-items setting (`ViewState.nesting`): the host hands a
 * view that draws attached rows (`nestsAttach`) the relation only while it is
 * `nested`; `roots` drops the rows that would attach; a row the read pages
 * never attaches.
 */

type Row = { id: string; parent: string | null; paged: boolean };
type ViewType = ResolvedViewInstance<DataViewContribution>["viewType"];

/** Prints what the host handed it: its rows, and each row's parent key. */
function ProbeView(props: DataViewRenderProps<unknown>) {
  const rows = props.rows as Row[];
  const attach = props.attach as DataViewAttachConfig<Row> | undefined;
  return (
    <div>
      <p data-testid="rows">{rows.map((r) => r.id).join(",")}</p>
      <p data-testid="parents">
        {attach
          ? rows.map((r) => attach.getParentKey(r) ?? "-").join(",")
          : "none"}
      </p>
    </div>
  );
}

const attachView = DataViewSlots.View({
  type: "attaching",
  title: "Attaching",
  icon: symbol("list"),
  nestsAttach: true,
  component: ProbeView,
}) as unknown as ViewType;
const plainView = DataViewSlots.View({
  type: "plain",
  title: "Plain",
  icon: symbol("list"),
  component: ProbeView,
}) as unknown as ViewType;

const plugin = {
  id: "data-view-attach-nesting-test",
  description: "attach nesting fixture",
  contributions: [attachView, plainView],
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
    dirtyFor: fakeViewGetter(() => false),
    drafts: null,
    homeViewId: null,
    renamingId: null,
    setRenamingId: () => {},
  };
}

const idField: FieldDef<Row> = {
  id: "id",
  label: "Id",
  type: "text",
  primary: true,
  value: (r) => r.id,
};

// sup ← worker; done (a paged row) ← sup; solo
const ROWS: Row[] = [
  { id: "sup", parent: null, paged: false },
  { id: "worker", parent: "sup", paged: false },
  { id: "done", parent: "sup", paged: true },
  { id: "solo", parent: null, paged: false },
];

const ATTACH: DataViewAttachConfig<Row> = {
  getKey: (r) => r.id,
  getParentKey: (r) => r.parent,
};

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
  paging?: DataViewPaging<Row>,
) {
  const m = model(viewType, nesting);
  const { Wrapper } = createLiveStateHarness();
  render(
    <Wrapper>
      <PluginProvider plugins={[plugin]}>
        <DataViewSectionsBody<Row>
          storageKey={"attach-nesting" as DataViewId}
          rows={ROWS}
          fields={[idField]}
          rowKey={(r) => r.id}
          attach={ATTACH}
          {...(paging ? { paging } : {})}
          viewModel={m}
          instances={m.instances}
          chrome={CHROME}
        />
      </PluginProvider>
    </Wrapper>,
  );
  const text = (id: string) => screen.getByTestId(id).textContent;
  return { rows: text("rows"), parents: text("parents") };
}

/** The paged body measures its rows on screen; nothing here is laid out. */
class InertIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("attach under Sub-items", () => {
  it("nested (default): the view gets the relation over every row", () => {
    const out = renderView(attachView, undefined);
    expect(out.rows).toBe("sup,worker,done,solo");
    expect(out.parents).toBe("-,sup,sup,-");
  });

  it("flat: every row, no relation", () => {
    const out = renderView(attachView, "flat");
    expect(out.rows).toBe("sup,worker,done,solo");
    expect(out.parents).toBe("none");
  });

  it("roots: the rows that would attach are dropped", () => {
    const out = renderView(attachView, "roots");
    expect(out.rows).toBe("sup,solo");
    expect(out.parents).toBe("none");
  });

  it("a row the read pages never attaches", () => {
    vi.stubGlobal("IntersectionObserver", InertIntersectionObserver);
    const out = renderView(
      attachView,
      undefined,
      consumerPaging<Row>([], [], [], (r) => r.paged),
    );
    expect(out.parents).toBe("-,sup,-,-");
  });

  it("a view type that draws no attached rows ignores it", () => {
    const out = renderView(plainView, "roots");
    expect(out.rows).toBe("sup,worker,done,solo");
    expect(out.parents).toBe("none");
  });
});
