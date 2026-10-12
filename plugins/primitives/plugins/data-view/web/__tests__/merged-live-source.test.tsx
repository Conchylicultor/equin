/**
 * A LIVE source through the merged (`MergedDataView`) path — the conversation
 * sidebar's History is the first merged surface whose source is a
 * `liveDataSource`. Mounted over `createLiveStateHarness` (a real client and its QueryClient),
 * with the view model stubbed (the config read is not under test) and one
 * minimal list view:
 *
 * - the active instance's state lowers onto the source's window tuple (the
 *   head segment the scroll subscribes, read back from the query cache) — the
 *   instance's sort and filter included;
 * - the rows the window holds render, keyed by the collection's id, with the
 *   bundle's `selectedRowId` and code-only `viewOptions` reaching the view;
 * - a collection whose column scope is the surface's `storageKey` mounts; one
 *   scoped to another surface is refused (contained by the source's boundary).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

let currentModel: unknown = null;
vi.mock("../internal/use-data-view-model", () => ({
  useDataViewModel: () => currentModel,
}));

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { z } from "zod";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  liveInstant,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type {
  DataViewId,
  DataViewRenderProps,
  FieldDef,
  ViewState,
} from "../../core";
import { liveDataSource } from "../internal/live-data-source";
import { defineDataViewSources } from "../internal/define-data-view-sources";
import { MergedDataView } from "../components/merged-data-view";
import { DataViewSlots } from "../slots";
import { fakeViewGetter } from "@plugins/primitives/plugins/data-view/plugins/view-core/web/testing";

const NO_COLLAPSED: ReadonlySet<string> = new Set();
const SECTION = { collapsed: false, hideWhenEmpty: false, description: null };

const LIST_ICON = symbol("view-list");

const STORAGE_KEY = "test-merged-sidebar" as DataViewId;

const Conv = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  createdAt: z.date(),
});
type Conv = z.infer<typeof Conv>;

let n = 0;
const convs = (columnScope: string) =>
  liveCollection(`test.data-view.merged-live-${n++}`, {
    row: Conv,
    id: "id",
    filterable: {
      title: liveText(),
      status: liveText(),
      createdAt: liveInstant(),
    },
    sortable: ["title", "createdAt"],
    default: { orderBy: [["createdAt", "desc"]], limit: 2 },
    maxLimit: 6,
    scroll: true,
    columnScope,
  });
type C = ReturnType<typeof convs>;

const FIELDS: FieldDef<Conv>[] = [
  { id: "title", label: "Title", type: "text", value: (c) => c.title },
  { id: "status", label: "Status", type: "text", value: (c) => c.status },
  {
    id: "createdAt",
    label: "Created",
    type: "date",
    value: (c) => c.createdAt,
  },
];

/** The one view: each row's id, the selected one marked, via the code-only renderRow. */
function TestList(props: DataViewRenderProps<unknown>): ReactElement {
  const renderRow = (props.options as { renderRow?: (r: Conv) => string })
    .renderRow;
  return (
    <ul data-testid="rows">
      {(props.rows as Conv[]).map((r, i) => (
        <li
          key={props.rowKey(r, i)}
          data-selected={props.selectedRowId === props.rowKey(r, i)}
        >
          {renderRow ? renderRow(r) : r.id}
        </li>
      ))}
    </ul>
  );
}

const LIST_VIEW = {
  type: "list",
  title: "List",
  icon: symbol("list"),
  component: TestList,
};

function model(state: ViewState) {
  const noop = () => {};
  return {
    ready: true,
    instances: [
      {
        instance: {
          id: "history",
          name: "History",
          icon: LIST_ICON,
          pickedIcon: null,
          type: "list",
          source: "history",
        },
        viewType: LIST_VIEW,
      },
    ],
    activeId: "history",
    setActiveView: noop,
    stateFor: fakeViewGetter(() => state),
    setSort: noop,
    setSortRules: noop,
    setVisibleFields: noop,
    setFilter: noop,
    setGroupBy: noop,
    setFold: noop,
    setQuery: noop,
    setExpanded: noop,
    collapsedSectionsFor: fakeViewGetter(() => NO_COLLAPSED),
    setSectionCollapsed: noop,
    sectionFor: fakeViewGetter(() => SECTION),
    setViewCollapsed: noop,
    actions: {
      availableSources: [],
      addView: noop,
      renameView: noop,
      setViewIcon: noop,
      duplicateView: noop,
      deleteView: noop,
      reorderView: noop,
      updateView: noop,
    },
  };
}

interface Host {
  activeId: string | null;
}

// The fixture plugin DECLARES the slots the merged host renders through (a slot
// id is minted from its declaring plugin): the surface's source slot, and the
// data-view's own (no data-view plugin is loaded here).
const Sources = defineDataViewSources<Host>();

function mount(c: C, state: ViewState, activeId: string | null = null) {
  currentModel = model(state);
  const source = liveDataSource(c, { searchable: ["title"] });
  function HistorySource({
    hostProps,
    render: renderBundle,
  }: {
    hostProps: Host;
    render: (bundle: never) => ReactElement;
  }): ReactElement {
    return renderBundle({
      fields: FIELDS,
      source,
      selectedRowId: hostProps.activeId ?? undefined,
      viewOptions: { list: { renderRow: (r: Conv) => `row ${r.id}` } },
    } as never);
  }
  const plugin = {
    id: "data-view-merged-live-test",
    description: "merged live source fixture",
    contributions: [
      Sources({
        id: "history",
        title: "History",
        icon: symbol("history"),
        component: HistorySource as never,
      }),
    ],
    slots: { ...DataViewSlots, sources: Sources },
  } as unknown as LoadedPlugin;
  const live = createLiveStateHarness();
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  const rendered = render(
    <live.Wrapper>
      <PluginProvider plugins={[plugin]}>
        <MergedDataView
          storageKey={STORAGE_KEY}
          sources={Sources}
          hostProps={{ activeId }}
        />
      </PluginProvider>
    </live.Wrapper>,
  );
  return { client: live.queryClient, ...rendered };
}

/** The window tuples of `c` the cache holds (one per subscribed segment). */
function tuples(client: QueryClient, c: C): unknown[] {
  return client
    .getQueryCache()
    .findAll()
    .filter((q) => (q.queryKey as unknown[])[0] === c.key)
    .map((q) => (q.queryKey as unknown[])[1] ?? {});
}

const wire = (ids: number[]) =>
  ids.map((i) => ({
    id: `c${i}`,
    title: `t${i}`,
    status: "working",
    createdAt: new Date(i * 1000),
    $key: JSON.stringify([String(i), `c${i}`]),
  }));

const baseState: ViewState = { sort: [], filter: null, query: "" };

/** The infinite-scroll sentinel's observer: inert (jsdom has none; nothing pages here). */
class InertIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

beforeEach(() => {
  resetDeferredLoadStateForTests();
  vi.stubGlobal("IntersectionObserver", InertIntersectionObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  currentModel = null;
  resetDeferredLoadStateForTests();
});

describe("MergedDataView — a live source", () => {
  it("lowers the active instance's state onto the source's window tuple", () => {
    const c = convs(STORAGE_KEY);
    const { client } = mount(c, {
      ...baseState,
      sort: [{ fieldId: "title", direction: "asc" }],
    });
    expect(tuples(client, c)).toContainEqual(
      c.window.window.encode({ orderBy: [["title", "asc"]], limit: 2 }),
    );
  });

  it("renders the rows the window holds, keyed by the collection's id, with the bundle's selection and view options", async () => {
    const c = convs(STORAGE_KEY);
    const { client } = mount(c, baseState, "c2");
    act(() => {
      client.setQueryData(queryKeyFor(c.key, { limit: "2" }), wire([2, 1]));
    });
    await waitFor(() =>
      expect(screen.getByTestId("rows").textContent).toBe("row c2row c1"),
    );
    const items = screen.getByTestId("rows").querySelectorAll("li");
    expect(items[0]!.getAttribute("data-selected")).toBe("true");
    expect(items[1]!.getAttribute("data-selected")).toBe("false");
  });

  it("a collection scoped to another surface is refused, never listed", () => {
    const c = convs("some-other-surface");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => mount(c, baseState)).toThrow(/column scope/);
    errors.mockRestore();
  });
});
