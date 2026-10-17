/**
 * The viewport a live source pages by, end to end: a `DataViewSwitcher` over a
 * live collection (`createLiveStateHarness` (a real client and its QueryClient), the view model
 * stubbed, one minimal list view stamping `data-row-key`), with an
 * IntersectionObserver that answers each row it is handed — as a browser does
 * — from the rows the test puts "on screen".
 *
 * - a head that lands after the skeleton was measured is not released: the
 *   measurement taken before its rows were drawn says nothing about them;
 * - a query change's new head is not released by the old rows' measurement;
 * - a page whose rows are all scrolled away IS released (the band still works).
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
import type { ReactElement } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { DataViewId, DataViewRenderProps, ViewState } from "../../core";
import { liveDataSource } from "../internal/live-data-source";
import { defineDataViewSources } from "../internal/define-data-view-sources";
import { DataViewSwitcher } from "../components/data-view-switcher";
import { DataViewSlots } from "../slots";
import { fakeViewGetter } from "@plugins/primitives/plugins/data-view/plugins/view-core/web/testing";

const NO_COLLAPSED: ReadonlySet<string> = new Set();
const SECTION = { collapsed: false, hideWhenEmpty: false, description: null };

const STORAGE_KEY = "test-live-viewport" as DataViewId;

type Conv = { id: string; title: string; createdAt: Date };

let n = 0;
const convs = () =>
  liveCollection(`test.data-view.live-viewport-${n++}`, {
    fields: {
      title: textField({ label: "Title" }),
      createdAt: dateField({ label: "Created" }),
    },
    carry: { fields: { id: textField() } },
    id: "id",
    sortable: ["title", "createdAt"],
    default: { orderBy: [["createdAt", "desc"]], limit: 2 },
    maxLimit: 6,
  });
type C = ReturnType<typeof convs>;

/** The one view: a row per entry, marked with its row key as every view's is. */
function TestList(props: DataViewRenderProps<unknown>): ReactElement {
  return (
    <ul data-testid="rows">
      {(props.rows as Conv[]).map((r, i) => (
        <li key={props.rowKey(r, i)} data-row-key={props.rowKey(r, i)}>
          {r.id}
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
          id: "all",
          name: "All",
          icon: symbol("view-list"),
          pickedIcon: null,
          type: "list",
          source: "all",
        },
        viewType: LIST_VIEW,
      },
    ],
    activeId: "all",
    setActiveView: noop,
    stateFor: fakeViewGetter(() => state),
    setSort: noop,
    setSortRules: noop,
    setProperties: noop,
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

const Sources = defineDataViewSources<Record<string, never>>();

function mount(c: C, state: ViewState) {
  currentModel = model(state);
  const source = liveDataSource(c, { searchable: ["title"] });
  function AllSource({
    render: renderBundle,
  }: {
    render: (bundle: never) => ReactElement;
  }): ReactElement {
    return renderBundle({ source } as never);
  }
  const plugin = {
    id: "data-view-live-viewport-test",
    description: "live viewport fixture",
    contributions: [
      Sources({
        id: "all",
        title: "All",
        icon: symbol("list"),
        component: AllSource as never,
      }),
    ],
    slots: { ...DataViewSlots, sources: Sources },
  } as unknown as LoadedPlugin;
  const live = createLiveStateHarness();
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  const tree = () => (
    <live.Wrapper>
      <PluginProvider plugins={[plugin]}>
        <DataViewSwitcher
          storageKey={STORAGE_KEY}
          sources={Sources}
          hostProps={{}}
        />
      </PluginProvider>
    </live.Wrapper>
  );
  const rendered = render(tree());
  const unobserve = vi.spyOn(live.notifications, "unobserve");
  return {
    client: live.queryClient,
    unobserve,
    /** Re-render under another view state (a sort picked, …). */
    setState: (next: ViewState) => {
      currentModel = model(next);
      rendered.rerender(tree());
    },
  };
}

const wire = (ids: number[]) =>
  ids.map((i) => ({
    id: `c${i}`,
    title: `t${i}`,
    createdAt: new Date(i * 1000),
    $key: JSON.stringify([String(i), `c${i}`]),
  }));

/** The rows "on screen": what the observer answers for each row it watches. */
const onScreen = new Set<string>();

/**
 * Answers every element it is handed, a tick later, as a browser does — a
 * row by whether it is on screen, anything else (the paging sentinel) off it.
 */
class ScreenIntersectionObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element): void {
    queueMicrotask(() =>
      this.cb(
        [
          {
            target: el,
            isIntersecting: onScreen.has(el.getAttribute("data-row-key") ?? ""),
          } as unknown as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      ),
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/** Let the viewport settle (its 250 ms window) — real time, as a scroll would. */
const settle = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));

/** Was the tuple `params` of `c` released (at once, as a page leaving its band)? */
const released = (
  unobserve: ReturnType<typeof mount>["unobserve"],
  c: C,
  params: Record<string, string>,
) =>
  unobserve.mock.calls.some(
    ([key, p, , release]) =>
      key === c.key &&
      JSON.stringify(p) === JSON.stringify(params) &&
      release === "now",
  );

beforeEach(() => {
  resetDeferredLoadStateForTests();
  onScreen.clear();
  vi.stubGlobal("IntersectionObserver", ScreenIntersectionObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  currentModel = null;
  resetDeferredLoadStateForTests();
});

const baseState: ViewState = { sort: [], filter: null, query: "" };

describe("DataView viewport — a live source", () => {
  it("a head landing after the skeleton was measured stays subscribed", async () => {
    const c = convs();
    const { client, unobserve } = mount(c, baseState);
    // The skeleton sat through a whole settle window first.
    await settle();
    onScreen.add("c2").add("c1");
    act(() => {
      client.setQueryData(queryKeyFor(c.key, { limit: "2" }), wire([2, 1]));
    });
    await waitFor(() =>
      expect(screen.getByTestId("rows").textContent).toBe("c2c1"),
    );
    await settle();
    expect(released(unobserve, c, { limit: "2" })).toBe(false);
    expect(
      client
        .getQueryCache()
        .find({ queryKey: queryKeyFor(c.key, { limit: "2" }), exact: true })
        ?.getObserversCount(),
    ).toBe(1);
  });

  it("a query change's new head is not released by the old rows' measurement", async () => {
    const c = convs();
    const { client, unobserve, setState } = mount(c, baseState);
    onScreen.add("c2").add("c1");
    act(() => {
      client.setQueryData(queryKeyFor(c.key, { limit: "2" }), wire([2, 1]));
    });
    await waitFor(() =>
      expect(screen.getByTestId("rows").textContent).toBe("c2c1"),
    );
    await settle();

    const sorted = { orderBy: [["title", "asc"]] as const, limit: 2 };
    const head = c.window.window.encode(sorted as never);
    setState({ ...baseState, sort: [{ fieldId: "title", direction: "asc" }] });
    onScreen.clear();
    onScreen.add("c7").add("c8");
    act(() => {
      client.setQueryData(queryKeyFor(c.key, head), wire([7, 8]));
    });
    await waitFor(() =>
      expect(screen.getByTestId("rows").textContent).toBe("c7c8"),
    );
    await settle();
    expect(released(unobserve, c, head)).toBe(false);
  });

  it("a read with none of its rows on screen releases its page", async () => {
    const c = convs();
    const { client, unobserve } = mount(c, baseState);
    act(() => {
      client.setQueryData(queryKeyFor(c.key, { limit: "2" }), wire([2, 1]));
    });
    await waitFor(() =>
      expect(screen.getByTestId("rows").textContent).toBe("c2c1"),
    );
    await settle();
    expect(released(unobserve, c, { limit: "2" })).toBe(true);
  });
});
