/**
 * A paged read's pages past the stale budget, drawn by the DataView as
 * height-keeping placeholders — against a laid-out page: every `[data-row-key]`
 * element stacks in document order (a row its own height, a placeholder its
 * `style.height`) inside a scroller whose `scrollTop` the test drives, and an
 * IntersectionObserver that answers from that layout, as a browser does.
 *
 * - a consumer's paging: a placeholder is one element per page, as tall as
 *   its rows at the measured row pitch, drawn through `primitives/loading`;
 *   on screen it is reported to the read by its key (which subscribes the
 *   page again); rows above the viewport turning into a placeholder of
 *   another height do not move the row being read (scroll anchoring); a
 *   read whose rows sit among others' (`isPaged`) draws none, and its far
 *   pages leaving the rows above the viewport are anchored all the same;
 * - a live source scrolled deep: the rows drawn stay bounded (the live band
 *   plus the stale budget) whatever the depth, the rest standing as
 *   placeholders — every row of the read accounted for.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

let currentModel: unknown = null;
vi.mock("../internal/use-data-view-model", () => ({
  useDataViewModel: () => currentModel,
}));

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { z } from "zod";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import {
  NotificationsProvider,
  getNotificationsClient,
  queryKeyFor,
} from "@plugins/primitives/plugins/live-state/web";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { liveNumber } from "@plugins/network/plugins/live/plugins/filter/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type {
  DataViewId,
  DataViewPagePlaceholder,
  DataViewPaging,
  DataViewRenderProps,
  DataViewVisibleRows,
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

const STORAGE_KEY = "test-page-placeholders" as DataViewId;

const Item = z.object({ id: z.string(), n: z.number() });
type Item = z.infer<typeof Item>;

const FIELDS: FieldDef<Item>[] = [
  { id: "n", label: "N", type: "number", value: (r) => r.n },
];

// ── The laid-out page ────────────────────────────────────────────────────

/** The scroller's visible height. */
const VIEW = 200;
/** A row's height, by key — what the "browser" lays it out at. */
let rowHeight: (key: string) => number = () => 20;
let scroller: HTMLElement | null = null;
let scrollTop = 0;
/** Every write to an element's `scrollTop`. */
let scrollWrites: MockInstance<(this: Element, v: number) => void> | null =
  null;
/** A stable ref: an inline one is detached through every commit, mid-layout. */
const holdScroller = (el: HTMLElement | null) => {
  if (el !== null) scroller = el;
};

const PLACEHOLDER = "data-page-placeholder";
const marked = (): HTMLElement[] =>
  scroller === null
    ? []
    : [...scroller.querySelectorAll<HTMLElement>("[data-row-key]")];
const heightOf = (el: HTMLElement) =>
  el.hasAttribute(PLACEHOLDER)
    ? parseFloat(el.style.height)
    : rowHeight(el.getAttribute("data-row-key")!);
/** Where `el` is on screen: the marked elements stack in document order. */
function rectOf(el: Element): DOMRect {
  if (el === scroller) return rect(0, VIEW);
  let y = -scrollTop;
  for (const m of marked()) {
    if (m === el) return rect(y, heightOf(m));
    y += heightOf(m);
  }
  return rect(0, 0);
}
const rect = (top: number, height: number) =>
  ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;
const contentHeight = () => marked().reduce((n, m) => n + heightOf(m), 0);
const onScreen = (el: Element): boolean => {
  if (el.hasAttribute("data-row-key")) {
    const r = rectOf(el);
    return r.bottom > 0 && r.top < VIEW && r.height > 0;
  }
  // Anything else (the paging sentinel) sits below the rows.
  return contentHeight() - scrollTop <= VIEW;
};

/** Answers each element it is handed, a tick later, then every crossing the test scrolls. */
class LayoutIntersectionObserver {
  static all = new Set<LayoutIntersectionObserver>();
  observed = new Set<Element>();
  constructor(private cb: IntersectionObserverCallback) {
    LayoutIntersectionObserver.all.add(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
    queueMicrotask(() => this.deliver([el]));
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.observed.clear();
    LayoutIntersectionObserver.all.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  deliver(els: Iterable<Element>): void {
    const entries = [...els]
      .filter((el) => el.isConnected)
      .map(
        (target) =>
          ({
            target,
            isIntersecting: onScreen(target),
            boundingClientRect: rectOf(target),
          }) as unknown as IntersectionObserverEntry,
      );
    if (entries.length > 0) {
      this.cb(entries, this as unknown as IntersectionObserver);
    }
  }
}

/** Scroll to `top`: every observer hears about every element it watches. */
function scrollTo(top: number): void {
  scrollTop = top;
  act(() => {
    for (const io of LayoutIntersectionObserver.all) io.deliver(io.observed);
  });
}

/** Let the viewport settle (its 250 ms window) — real time, as a scroll would. */
const settle = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));

// ── The DataView ─────────────────────────────────────────────────────────

/** The one view: a row per entry, marked with its row key as every view's is. */
function TestList(props: DataViewRenderProps<unknown>): ReactElement {
  return (
    <ul data-testid="rows">
      {(props.rows as Item[]).map((r, i) => (
        <li key={props.rowKey(r, i)} data-row-key={props.rowKey(r, i)}>
          {r.id}
        </li>
      ))}
    </ul>
  );
}

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
        viewType: {
          type: "list",
          title: "List",
          icon: symbol("list"),
          component: TestList,
        },
      },
    ],
    activeId: "all",
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

const Sources = defineDataViewSources<Record<string, never>>();

// ONE client for the file: the NotificationsClient is a tab singleton, made
// against the first provider's client (a released page's cache is dropped
// from that one).
const CLIENT = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnMount: false, staleTime: Infinity },
  },
});

/** Mount a MergedDataView whose one source renders `bundle()` — re-read on every `rerender`. */
function mount(bundle: () => object) {
  currentModel = model({ sort: [], filter: null, query: "" });
  function AllSource({
    render: renderBundle,
  }: {
    render: (b: never) => ReactElement;
  }): ReactElement {
    return renderBundle(bundle() as never);
  }
  const plugin = {
    id: "data-view-page-placeholders-test",
    description: "page placeholders fixture",
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
  const tree = () => (
    <NotificationsProvider queryClient={CLIENT}>
      <PluginProvider plugins={[plugin]}>
        <div
          data-testid="scroller"
          ref={holdScroller}
          style={{ overflowY: "auto" }}
        >
          <MergedDataView
            storageKey={STORAGE_KEY}
            sources={Sources}
            hostProps={{}}
          />
        </div>
      </PluginProvider>
    </NotificationsProvider>
  );
  const rendered = render(tree());
  const notifications = getNotificationsClient();
  if (!notifications) throw new Error("NotificationsClient not created");
  vi.spyOn(notifications, "hasEverBeenReady").mockReturnValue(true);
  return { notifications, rerender: () => rendered.rerender(tree()) };
}

const placeholders = () =>
  [...document.querySelectorAll<HTMLElement>(`[${PLACEHOLDER}]`)].map((el) => ({
    key: el.getAttribute("data-row-key"),
    height: el.style.height,
  }));
const drawnRows = () =>
  marked()
    .filter((el) => !el.hasAttribute(PLACEHOLDER))
    .map((el) => el.getAttribute("data-row-key")!);

beforeEach(() => {
  resetDeferredLoadStateForTests();
  scrollTop = 0;
  rowHeight = () => 20;
  LayoutIntersectionObserver.all.clear();
  vi.stubGlobal("IntersectionObserver", LayoutIntersectionObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      return rectOf(this);
    },
  );
  // The scroller's offset is the test's: a write moves it, as a browser's would.
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (
    this: Element,
  ) {
    return this === scroller ? scrollTop : 0;
  });
  scrollWrites = vi.spyOn(Element.prototype, "scrollTop", "set");
  scrollWrites.mockImplementation(function (this: Element, v: number) {
    if (this === scroller) scrollTop = v;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cleanup();
  currentModel = null;
  scroller = null;
  resetDeferredLoadStateForTests();
});

// ── A consumer's paging: what the body draws and reports ─────────────────

const items = (from: number, to: number): Item[] =>
  Array.from({ length: to - from }, (_, i) => ({
    id: `c${from + i}`,
    n: from + i,
  }));

function consumerPaging(
  before: readonly DataViewPagePlaceholder[],
  after: readonly DataViewPagePlaceholder[],
  reports: DataViewVisibleRows[],
  isPaged?: (row: Item) => boolean,
): DataViewPaging<Item> {
  return {
    canGrow: false,
    growing: false,
    loadMore: () => {},
    complete: false,
    stalled: null,
    truncated: false,
    notices: [],
    viewport: { report: (rows) => reports.push(rows) },
    placeholders: { before, after },
    ...(isPaged ? { isPaged } : {}),
  };
}

describe("page placeholders — what the DataView draws", () => {
  it("one element per page, as tall as its rows; on screen, reported to the read by its key", async () => {
    const reports: DataViewVisibleRows[] = [];
    let rows = items(0, 10);
    let paging = consumerPaging([], [], reports);
    const { rerender } = mount(() => ({
      fields: FIELDS,
      rows,
      rowKey: (r: Item) => r.id,
      paging,
    }));
    await waitFor(() => expect(drawnRows()).toHaveLength(10));
    scrollTo(0);
    await settle();
    // Rows c4… shown, and two far pages of 2 rows before them, one after.
    rows = items(4, 10);
    paging = consumerPaging(
      [
        { key: "page-a", rows: 2 },
        { key: "page-b", rows: 2 },
      ],
      [{ key: "page-z", rows: 3 }],
      reports,
    );
    act(() => rerender());
    // page-a / page-b at the room c0–c3 took (20px each); page-z, standing
    // for rows never drawn, at the pitch measured from the rows: 20px.
    expect(placeholders()).toEqual([
      { key: "page-a", height: "40px" },
      { key: "page-b", height: "40px" },
      { key: "page-z", height: "60px" },
    ]);
    // Never a row: drawn through the loading primitive, no field rendered.
    const first = document.querySelector(`[${PLACEHOLDER}]`)!;
    expect(first.querySelector('[role="status"]')).not.toBeNull();
    expect(first.textContent).toBe("");
    expect(drawnRows()).toEqual(items(4, 10).map((r) => r.id));

    // At the top: the placeholders are what is on screen, named by key.
    scrollTo(0);
    await settle();
    expect(reports.at(-1)).toEqual({
      kind: "rows",
      first: "page-a",
      last: "c9",
    });
  });

  it("a page released above the viewport is drawn at exactly the room its rows took: nothing moves, nothing is anchored", async () => {
    // c0–c3 are tall; the rows on screen (and so the pitch) are 20px.
    rowHeight = (key) => (["c0", "c1", "c2", "c3"].includes(key) ? 50 : 20);
    const reports: DataViewVisibleRows[] = [];
    let rows = items(0, 10);
    let paging = consumerPaging([], [], reports);
    const { rerender } = mount(() => ({
      fields: FIELDS,
      rows,
      rowKey: (r: Item) => r.id,
      paging,
    }));
    await waitFor(() => expect(drawnRows()).toHaveLength(10));
    // c5 at the top of the screen: 4 × 50 + 20 above it.
    scrollTo(220);
    await settle();
    expect(rectOf(document.querySelector('[data-row-key="c5"]')!).top).toBe(0);
    expect(reports.at(-1)).toEqual({ kind: "rows", first: "c5", last: "c9" });
    scrollWrites!.mockClear();

    // c0–c3 released past the budget: one placeholder as tall as they were
    // (4 × 50), not 4 rows at the 20px pitch.
    rows = items(4, 10);
    paging = consumerPaging([{ key: "page-a", rows: 4 }], [], reports);
    act(() => rerender());
    expect(placeholders()).toEqual([{ key: "page-a", height: "200px" }]);
    expect(scrollTop).toBe(220);
    expect(rectOf(document.querySelector('[data-row-key="c5"]')!).top).toBe(0);
    // Held by the layout itself — the scroller was never written.
    expect(scrollWrites).not.toHaveBeenCalled();

    // And back: the page's rows land in its place — taller than they were
    // (changed while away): the reader is anchored.
    rowHeight = (key) => (["c0", "c1", "c2", "c3"].includes(key) ? 60 : 20);
    rows = items(0, 10);
    paging = consumerPaging([], [], reports);
    act(() => rerender());
    expect(placeholders()).toEqual([]);
    expect(scrollTop).toBe(260);
    expect(rectOf(document.querySelector('[data-row-key="c5"]')!).top).toBe(0);
  });

  it("several pages released at once share their rows' room row for row", async () => {
    rowHeight = (key) => (key === "c0" ? 80 : 20);
    const reports: DataViewVisibleRows[] = [];
    let rows = items(0, 10);
    let paging = consumerPaging([], [], reports);
    const { rerender } = mount(() => ({
      fields: FIELDS,
      rows,
      rowKey: (r: Item) => r.id,
      paging,
    }));
    await waitFor(() => expect(drawnRows()).toHaveLength(10));
    scrollTo(140);
    await settle();
    rows = items(4, 10);
    paging = consumerPaging(
      [
        { key: "page-a", rows: 1 },
        { key: "page-b", rows: 3 },
      ],
      [],
      reports,
    );
    act(() => rerender());
    expect(placeholders()).toEqual([
      { key: "page-a", height: "80px" },
      { key: "page-b", height: "60px" },
    ]);
    expect(scrollTop).toBe(140);
  });

  it("a read whose rows sit among others' (isPaged) draws no placeholder", async () => {
    const reports: DataViewVisibleRows[] = [];
    const paging = consumerPaging(
      [{ key: "page-a", rows: 2 }],
      [{ key: "page-z", rows: 2 }],
      reports,
      (r) => r.n >= 5,
    );
    mount(() => ({
      fields: FIELDS,
      rows: items(0, 10),
      rowKey: (r: Item) => r.id,
      paging,
    }));
    await waitFor(() => expect(drawnRows()).toHaveLength(10));
    expect(placeholders()).toEqual([]);
  });

  it("under isPaged, the read's far pages leaving the rows above the viewport leave the row being read where it is", async () => {
    const reports: DataViewVisibleRows[] = [];
    const isPaged = () => true;
    let rows = items(0, 10);
    let paging = consumerPaging([], [], reports, isPaged);
    const { rerender } = mount(() => ({
      fields: FIELDS,
      rows,
      rowKey: (r: Item) => r.id,
      paging,
    }));
    await waitFor(() => expect(drawnRows()).toHaveLength(10));
    scrollTo(100);
    await settle();
    expect(rectOf(document.querySelector('[data-row-key="c5"]')!).top).toBe(0);

    // c0–c3 released past the budget: no placeholder is drawn, their rows
    // simply leave — 80px less above the reader.
    rows = items(4, 10);
    paging = consumerPaging([{ key: "page-a", rows: 4 }], [], reports, isPaged);
    act(() => rerender());
    expect(placeholders()).toEqual([]);
    expect(scrollTop).toBe(20);
    expect(rectOf(document.querySelector('[data-row-key="c5"]')!).top).toBe(0);

    // And back: the page's rows land above — still anchored.
    rows = items(0, 10);
    paging = consumerPaging([], [], reports, isPaged);
    act(() => rerender());
    expect(scrollTop).toBe(100);
    expect(rectOf(document.querySelector('[data-row-key="c5"]')!).top).toBe(0);
  });
});

// ── A live source scrolled deep ──────────────────────────────────────────

const TOTAL = 80;
let n = 0;
const items_ = () =>
  liveCollection(`test.data-view.page-placeholders-${n++}`, {
    row: Item,
    id: "id",
    filterable: { n: liveNumber() },
    sortable: ["n"],
    default: { orderBy: [["n", "asc"]], limit: 2 },
    maxLimit: 6,
    scroll: true,
  });

const keyOf = (i: number) => JSON.stringify([String(i), `c${i}`]);
const rankOf = (key: string) => Number((JSON.parse(key) as string[])[0]);
/** The server: each window tuple answered as Postgres would, over rows 0 … TOTAL − 1. */
function windowOf(params: Record<string, string>) {
  const after = params.after === undefined ? -1 : rankOf(params.after);
  const until = params.until === undefined ? Infinity : rankOf(params.until);
  const out = [];
  for (let i = after + 1; i < TOTAL && i <= until; i++) {
    out.push({ id: `c${i}`, n: i, $key: keyOf(i) });
    if (out.length === Number(params.limit)) break;
  }
  return out;
}

describe("page placeholders — a live source scrolled deep", () => {
  it("the rows drawn stay bounded however deep the read goes; the rest stand as placeholders", async () => {
    const c = items_();
    const source = liveDataSource(c, { searchable: [] });
    const { notifications } = mount(() => ({ fields: FIELDS, source }));
    // Every subscribed tuple is answered a tick later, as a sub-ack would.
    const observe = notifications.observe.bind(notifications);
    vi.spyOn(notifications, "observe").mockImplementation(
      (key, params = {}, ...rest) => {
        observe(key, params, ...rest);
        if (key !== c.key) return;
        setTimeout(() =>
          act(() => {
            CLIENT.setQueryData(
              queryKeyFor(key, params),
              windowOf(params as Record<string, string>),
            );
          }),
        );
      },
    );
    act(() => {
      CLIENT.setQueryData(
        queryKeyFor(c.key, { limit: "2" }),
        windowOf({ limit: "2" }),
      );
    });
    await waitFor(() => expect(drawnRows()).toEqual(["c0", "c1"]));

    // Scroll to the bottom again and again: the sentinel pages the read in,
    // and the pages left behind are released.
    const accounted = () =>
      drawnRows().length +
      [...document.querySelectorAll<HTMLElement>(`[${PLACEHOLDER}]`)].length;
    for (let i = 0; i < 400; i++) {
      scrollTo(Math.max(0, contentHeight() - VIEW));
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
      if (drawnRows().includes(`c${TOTAL - 1}`) && accounted() > 0) {
        const placeholdersShown = document.querySelectorAll(`[${PLACEHOLDER}]`);
        if (placeholdersShown.length > 0) break;
      }
    }
    expect(drawnRows()).toContain(`c${TOTAL - 1}`);
    // Held still at the bottom: the viewport settles, the far pages go.
    scrollTo(Math.max(0, contentHeight() - VIEW));
    await settle();
    await settle();
    scrollTo(Math.max(0, contentHeight() - VIEW));
    await settle();

    const shown = drawnRows();
    // The live band (the pages on screen ± 2, each at most 2·step rows) and
    // the stale budget (8 steps of 2 rows) — never the whole read.
    expect(shown.length).toBeLessThanOrEqual(5 * 4 + 16);
    expect(shown.at(-1)).toBe(`c${TOTAL - 1}`);
    // Every row of the read accounted for: drawn, or inside a placeholder of
    // the pitch's height per row it stands for.
    const ph = [...document.querySelectorAll<HTMLElement>(`[${PLACEHOLDER}]`)];
    expect(ph.length).toBeGreaterThan(0);
    const standIn = ph.reduce(
      (sum, el) => sum + parseFloat(el.style.height) / 20,
      0,
    );
    expect(shown.length + standIn).toBe(TOTAL);
    // The rows drawn are the order's tail, after the placeholders.
    const firstShown = Number(shown[0]!.slice(1));
    expect(shown).toEqual(
      Array.from(
        { length: TOTAL - firstShown },
        (_, i) => `c${firstShown + i}`,
      ),
    );
    expect(marked()[0]!.hasAttribute(PLACEHOLDER)).toBe(true);
  }, 60_000);
});
