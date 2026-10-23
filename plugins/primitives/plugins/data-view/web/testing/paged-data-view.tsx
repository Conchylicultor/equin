import { onTestFinished, vi, type MockInstance } from "vitest";
import { act, render } from "@testing-library/react";
import type { ComponentType } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  createLiveStateHarness,
  type LiveStateHarness,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { fakeViewGetter } from "@plugins/primitives/plugins/data-view/plugins/view-core/web/testing";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type {
  DataViewId,
  DataViewPagePlaceholder,
  DataViewPaging,
  DataViewRenderProps,
  DataViewVisibleRows,
  ViewState,
} from "../../core";
import { DataViewShellFrame } from "../components/data-view";
import { DataViewBody } from "../components/data-view-body";
import type { DataViewSourceBundle } from "../internal/body-types";
import type { ViewModel } from "../internal/use-data-view-model";
import { DataViewSlots } from "../slots";

/**
 * How the "browser" lays the view out — every `[data-row-key]` element (a row,
 * a card, a placeholder) placed in document order, which is all the paging
 * machinery measures:
 *
 * - `"stack"`: each one below the last, a row at its height (20 px unless
 *   the test sets one, `setRowHeight`), a placeholder at its `style.height` —
 *   a list, a table;
 * - `{ columns, linePx }`: a lane-aware grid — cells (cards, and the
 *   `[data-grid-pad]` spacers, which take a cell but are never measured) fill
 *   `columns` per line, a line as tall as its tallest card (`linePx` unless
 *   the test sets one), a new grid element starts a new line, and a
 *   placeholder is a block of its own between lines. Both column reads a
 *   grid view makes are stubbed to answer `columns`: the gallery and icons
 *   probes' `grid-template-columns` (`columns` tracks, no gap), and every
 *   box's `clientWidth` (`columns` × 200 px).
 */
export type PagedLayout = "stack" | { columns: number; linePx: number };

/** The view under test — passed in, since data-view cannot import its views. */
export interface PagedViewUnderTest {
  type: string;
  component: ComponentType<DataViewRenderProps<unknown>>;
}

export interface PagedDataView {
  /** Re-render, reading `bundle()` again. */
  rerender: () => void;
  /** Scroll to `top`: every IntersectionObserver hears about every element it watches. */
  scrollTo: (top: number) => void;
  /** Let the viewport settle (its 250 ms window) — real time, as a scroll would. */
  settle: () => Promise<void>;
  /** The scroller's offset. */
  scrollTop: () => number;
  /** Writes to any scroll offset (`scrollTop =`, `scrollTo`, `scrollBy`) since the last `clearScrollWrites`. */
  scrollWrites: () => number;
  clearScrollWrites: () => void;
  /** The drawn placeholders, in order: their key and `style.height`. */
  placeholders: () => { key: string | null; height: string }[];
  /** The drawn rows' keys (placeholders excluded), in document order. */
  drawnRows: () => string[];
  /** The element drawn for row `key` (throws when none is). */
  element: (key: string) => HTMLElement;
  /** Where row `key` is on screen: its top in px, and its column (0 in a stack). */
  layoutOf: (key: string) => { top: number; column: number };
  /** Everything laid out, in px. */
  contentHeight: () => number;
  /** A row's (a card's) height by key, from now on; `undefined` → the layout's default. */
  setRowHeight: (height: (key: string) => number | undefined) => void;
  /** The live-state pair the DataView is mounted in (a live `source` reads through it). */
  notifications: LiveStateHarness["notifications"];
  queryClient: LiveStateHarness["queryClient"];
}

/** The scroller's visible height. */
export const PAGED_VIEWPORT_PX = 200;

const STORAGE_KEY = "test-paged-data-view" as DataViewId;
const PLACEHOLDER = "data-page-placeholder";
const NO_COLLAPSED: ReadonlySet<string> = new Set();
const SECTION = { collapsed: false, hideWhenEmpty: false, description: null };
const STATE: ViewState = { sort: [], filter: null, query: "" };

const plugin = {
  id: "data-view-paged-harness",
  description: "paged DataView harness",
  contributions: [],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

/**
 * Mount ONE view of a paged DataView against a laid-out page — through the
 * real seam (`DataViewShellFrame` around `DataViewBody`, the body every
 * DataView renders), with a fake one-instance view model, inside a scroller
 * whose `scrollTop` the test drives and an IntersectionObserver that answers
 * from the layout, as a browser does. Every stub is installed here and
 * restored when the test finishes.
 *
 * `bundle` is any data origin (in-memory rows with `paging`, or a live
 * `source`), re-read on every `rerender`.
 */
export function mountPagedDataView<TRow>(opts: {
  view: PagedViewUnderTest;
  bundle: () => DataViewSourceBundle<TRow>;
  layout: PagedLayout;
}): PagedDataView {
  const page = new LaidOutPage(opts.layout);
  page.install();
  onTestFinished(() => page.restore());

  const model = viewModel(opts.view);
  const live = createLiveStateHarness();
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  const tree = () => (
    <live.Wrapper>
      <PluginProvider plugins={[plugin]}>
        <div
          data-testid="scroller"
          ref={page.holdScroller}
          style={{ overflowY: "auto" }}
        >
          <DataViewShellFrame storageKey={STORAGE_KEY} viewModel={model}>
            {(activeInstance, chrome, settled) => (
              <DataViewBody<TRow>
                {...opts.bundle()}
                storageKey={STORAGE_KEY}
                viewModel={settled}
                activeInstance={activeInstance}
                chrome={chrome}
              />
            )}
          </DataViewShellFrame>
        </div>
      </PluginProvider>
    </live.Wrapper>
  );
  const rendered = render(tree());

  return {
    rerender: () => act(() => rendered.rerender(tree())),
    scrollTo: (top) => page.scrollTo(top),
    settle: () =>
      act(() => new Promise<void>((resolve) => setTimeout(resolve, 400))),
    scrollTop: () => page.scrollTop,
    scrollWrites: () => page.writes,
    clearScrollWrites: () => {
      page.writes = 0;
    },
    placeholders: () =>
      page.marked().flatMap((el) =>
        el.hasAttribute(PLACEHOLDER)
          ? [
              {
                key: el.getAttribute("data-row-key"),
                height: el.style.height,
              },
            ]
          : [],
      ),
    drawnRows: () =>
      page
        .marked()
        .filter((el) => !el.hasAttribute(PLACEHOLDER))
        .map((el) => el.getAttribute("data-row-key")!),
    element: (key) => page.element(key),
    layoutOf: (key) => {
      const box = page.layout().get(page.element(key))!;
      return { top: box.top - page.scrollTop, column: box.column };
    },
    contentHeight: () => page.contentHeight(),
    setRowHeight: (height) => {
      page.rowHeight = height;
    },
    notifications: live.notifications,
    queryClient: live.queryClient,
  };
}

/**
 * A consumer's paging (`DataViewProps.paging`): placeholders before and after
 * the rows, every viewport report pushed to `reports`, nothing to grow.
 */
export function consumerPaging<TRow>(
  before: readonly DataViewPagePlaceholder[],
  after: readonly DataViewPagePlaceholder[],
  reports: DataViewVisibleRows[],
  isPaged?: (row: TRow) => boolean,
): DataViewPaging<TRow> {
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

/** A one-instance ready view model showing `view`. */
function viewModel(view: PagedViewUnderTest): ViewModel {
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
          type: view.type,
          source: "all",
        },
        viewType: {
          type: view.type,
          title: view.type,
          icon: symbol("list"),
          component: view.component,
        },
      },
    ],
    activeId: "all",
    setActiveView: noop,
    stateFor: fakeViewGetter(() => STATE),
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
  } as unknown as ViewModel;
}

/** One laid-out element: its top in content px, height, and column. */
interface Box {
  top: number;
  height: number;
  column: number;
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

/** The page the DataView is laid out on, and the browser stubs that read it. */
class LaidOutPage {
  scroller: HTMLElement | null = null;
  scrollTop = 0;
  writes = 0;
  rowHeight: (key: string) => number | undefined = () => undefined;
  readonly grid: { columns: number; linePx: number } | null;
  private readonly undo: (() => void)[] = [];

  constructor(layout: PagedLayout) {
    this.grid = layout === "stack" ? null : { ...layout };
  }

  /** A stable ref: an inline one is detached through every commit, mid-layout. */
  readonly holdScroller = (el: HTMLElement | null) => {
    if (el !== null) this.scroller = el;
  };

  marked(): HTMLElement[] {
    return this.laidOut("[data-row-key]");
  }

  /**
   * What the page lays out under `selector` — never inside an `inert` box
   * (`virtual-rows`' invisible measuring copy of an item takes no room).
   */
  laidOut(selector: string): HTMLElement[] {
    if (this.scroller === null) return [];
    return [...this.scroller.querySelectorAll<HTMLElement>(selector)].filter(
      (el) => el.closest("[inert]") === null,
    );
  }

  element(key: string): HTMLElement {
    // Matched by value, not a selector: a live page's key is JSON.
    const el = this.marked().find(
      (m) => m.getAttribute("data-row-key") === key,
    );
    if (!el) throw new Error(`no element drawn for row ${key}`);
    return el;
  }

  /** The last layout, and what it was computed from. */
  private memo: {
    atoms: HTMLElement[];
    heights: string[];
    rowHeight: (key: string) => number | undefined;
    layout: Map<Element, Box>;
  } | null = null;

  /**
   * Every laid-out element's box, in content px — recomputed only when what
   * it is computed from changed (the elements, a placeholder's height, the
   * row heights): a windowed grid measures every line on every commit.
   */
  layout(): Map<Element, Box> {
    const atoms = this.laidOut("[data-row-key], [data-grid-pad]");
    const heights = atoms.map((el) => el.style.height);
    const memo = this.memo;
    if (
      memo !== null &&
      memo.rowHeight === this.rowHeight &&
      memo.atoms.length === atoms.length &&
      memo.atoms.every((el, i) => el === atoms[i]) &&
      memo.heights.every((h, i) => h === heights[i])
    ) {
      return memo.layout;
    }
    const layout = this.computeLayout();
    this.memo = { atoms, heights, rowHeight: this.rowHeight, layout };
    return layout;
  }

  private computeLayout(): Map<Element, Box> {
    const out = new Map<Element, Box>();
    if (this.scroller === null) return out;
    const isPlaceholder = (el: Element) => el.hasAttribute(PLACEHOLDER);
    const keyOf = (el: Element) => el.getAttribute("data-row-key");
    let y = 0;
    if (this.grid === null) {
      for (const el of this.marked()) {
        const height = isPlaceholder(el)
          ? parseFloat(el.style.height)
          : (this.rowHeight(keyOf(el)!) ?? 20);
        out.set(el, { top: y, height, column: 0 });
        y += height;
      }
      return out;
    }
    // Lines of cells (or a placeholder, a block of its own), then each line
    // laid out as tall as its tallest card.
    const { columns, linePx } = this.grid;
    const lines: HTMLElement[][] = [];
    let line: HTMLElement[] = [];
    let grid: Element | null = null;
    const breakLine = () => {
      if (line.length > 0) lines.push(line);
      line = [];
    };
    for (const el of this.laidOut("[data-row-key], [data-grid-pad]")) {
      if (isPlaceholder(el)) {
        breakLine();
        lines.push([el]);
        grid = null;
        continue;
      }
      const container = el.parentElement?.closest(".grid") ?? null;
      if (container !== grid) breakLine();
      grid = container;
      line.push(el);
      if (line.length === columns) breakLine();
    }
    breakLine();
    for (const cells of lines) {
      const first = cells[0]!;
      if (isPlaceholder(first)) {
        const height = parseFloat(first.style.height);
        out.set(first, { top: y, height, column: 0 });
        y += height;
        continue;
      }
      const height = Math.max(
        ...cells.map((el) => {
          const key = keyOf(el);
          return key === null ? linePx : (this.rowHeight(key) ?? linePx);
        }),
      );
      cells.forEach((el, column) => out.set(el, { top: y, height, column }));
      y += height;
    }
    return out;
  }

  contentHeight(): number {
    let bottom = 0;
    for (const box of this.layout().values()) {
      bottom = Math.max(bottom, box.top + box.height);
    }
    return bottom;
  }

  /**
   * Where `el` is on screen: a laid-out element its box; any other element
   * spans the laid-out elements inside it (a windowed line's wrapper is its
   * line), or is an empty box at the top when it holds none.
   */
  rectOf(el: Element): DOMRect {
    if (el === this.scroller) return rect(0, PAGED_VIEWPORT_PX);
    const layout = this.layout();
    const own = layout.get(el);
    if (own !== undefined) return rect(own.top - this.scrollTop, own.height);
    let top = Infinity;
    let bottom = -Infinity;
    for (const [inner, box] of layout) {
      if (!el.contains(inner)) continue;
      top = Math.min(top, box.top);
      bottom = Math.max(bottom, box.top + box.height);
    }
    return top === Infinity
      ? rect(0, 0)
      : rect(top - this.scrollTop, bottom - top);
  }

  onScreen(el: Element): boolean {
    if (el.hasAttribute("data-row-key")) {
      const r = this.rectOf(el);
      return r.bottom > 0 && r.top < PAGED_VIEWPORT_PX && r.height > 0;
    }
    // Anything else (the paging sentinel) sits below the rows.
    return this.contentHeight() - this.scrollTop <= PAGED_VIEWPORT_PX;
  }

  scrollTo(top: number): void {
    this.scrollTop = top;
    act(() => {
      for (const io of LayoutIntersectionObserver.all) io.deliver(io.observed);
    });
  }

  install(): void {
    // The stubs below are `function`s, whose `this` is the element.
    const page = this;
    LayoutIntersectionObserver.page = this;
    LayoutIntersectionObserver.all.clear();
    vi.stubGlobal("IntersectionObserver", LayoutIntersectionObserver);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        return page.rectOf(this);
      },
    );
    // Boxes as a windowed view's virtualizer reads them: each element as tall
    // as the page lays it out (a windowed line's wrapper, its line), and the
    // scroller tall enough that it mounts every line — so the page, laid out
    // in document order, holds all of them (the paging viewport is still the
    // 200 px the IntersectionObserver answers from).
    for (const dim of ["offsetHeight", "clientHeight"] as const) {
      vi.spyOn(HTMLElement.prototype, dim, "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return this === page.scroller ? 1_000_000 : page.rectOf(this).height;
      });
    }
    // The scroller's offset is the test's: a write moves it, as a browser's would.
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(
      function (this: Element) {
        return this === page.scroller ? page.scrollTop : 0;
      },
    );
    const setter: MockInstance<(this: Element, v: number) => void> = vi.spyOn(
      Element.prototype,
      "scrollTop",
      "set",
    );
    setter.mockImplementation(function (this: Element, v: number) {
      page.writes++;
      if (this === page.scroller) page.scrollTop = v;
    });
    for (const name of ["scrollTo", "scrollBy"] as const) {
      const own = Object.getOwnPropertyDescriptor(Element.prototype, name);
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        writable: true,
        value(this: Element, ...args: unknown[]) {
          page.writes++;
          if (this !== page.scroller) return;
          const a = args[0];
          const top =
            typeof a === "object" && a !== null
              ? (a as ScrollToOptions).top
              : (args[1] as number | undefined);
          if (top === undefined) return;
          page.scrollTop = name === "scrollTo" ? top : page.scrollTop + top;
        },
      });
      this.undo.push(() => {
        if (own) Object.defineProperty(Element.prototype, name, own);
        else delete (Element.prototype as Partial<Element>)[name];
      });
    }
    if (this.grid !== null) {
      const grid = this.grid;
      // Every box is as wide as `columns` cards of 200 px.
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
        () => grid.columns * 200,
      );
      // The gallery and icons probes' resolved tracks; no gap anywhere.
      const computed = window.getComputedStyle.bind(window);
      vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
        const style = computed(el, pseudo);
        Object.defineProperties(style, {
          gridTemplateColumns: {
            configurable: true,
            value: Array.from({ length: grid.columns }, () => "200px").join(
              " ",
            ),
          },
          columnGap: { configurable: true, value: "0px" },
        });
        return style;
      });
    }
  }

  restore(): void {
    for (const undo of this.undo.splice(0)) undo();
    LayoutIntersectionObserver.all.clear();
    LayoutIntersectionObserver.page = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}

/** Answers each element it is handed, a tick later, then every crossing the test scrolls. */
class LayoutIntersectionObserver {
  static all = new Set<LayoutIntersectionObserver>();
  static page: LaidOutPage | null = null;
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
    const page = LayoutIntersectionObserver.page;
    if (page === null) return;
    const entries = [...els]
      .filter((el) => el.isConnected)
      .map(
        (target) =>
          ({
            target,
            isIntersecting: page.onScreen(target),
            boundingClientRect: page.rectOf(target),
          }) as unknown as IntersectionObserverEntry,
      );
    if (entries.length > 0) {
      this.cb(entries, this as unknown as IntersectionObserver);
    }
  }
}
