/**
 * A paged gallery keeps every card in the column it was drawn in when the
 * pages above it are released (turned into a placeholder) or land back: the
 * band starts with as many empty spacer cells as the released cards' phase
 * (`useGridPhase`), the spacers carry no `data-row-key`, and the windowed
 * lines are keyed by absolute line — so a release keeps the mounted lines'
 * DOM. The grid's column count is stubbed through the probe's resolved tracks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  DataViewSlots,
  type DataViewRenderProps,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type { DataViewPagePlaceholders } from "@plugins/primitives/plugins/data-view/core";
import { GalleryView } from "../components/gallery-view";

const plugin = {
  id: "data-view-gallery-paged-phase-test",
  description: "gallery paged-phase fixture",
  contributions: [],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name: string };
const name: FieldDef<Row> = {
  id: "name",
  label: "Name",
  type: "plain",
  value: (r) => r.name,
  primary: true,
};

/** Columns the probe resolves: 4 tracks. */
const COLUMNS = 4;

const rowsOf = (from: number, to: number): Row[] =>
  Array.from({ length: to - from }, (_, i) => ({
    id: `r${from + i}`,
    name: `card ${from + i}`,
  }));

const NONE: DataViewPagePlaceholders = { before: [], after: [] };
const releasedAbove = (rows: number): DataViewPagePlaceholders => ({
  before: [{ key: "page:0", rows }],
  after: [],
});

function props(
  rows: Row[],
  placeholders: DataViewPagePlaceholders | undefined,
): DataViewRenderProps<unknown> {
  const p: DataViewRenderProps<Row> = {
    revealSelection: true,
    rows,
    fields: [name],
    rowKey: (r) => r.id,
    state: { sort: [], query: "", filter: null },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: () => {},
    // Ungrouped: the clock is never consulted.
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    options: undefined,
    placeholders,
  };
  return p as DataViewRenderProps<unknown>;
}

function mount(
  rows: Row[],
  placeholders: DataViewPagePlaceholders | undefined,
) {
  const view = render(
    <PluginProvider plugins={[plugin]}>
      <div data-scroller style={{ overflowY: "auto" }}>
        <GalleryView {...props(rows, placeholders)} />
      </div>
    </PluginProvider>,
  );
  return {
    ...view,
    update: (next: Row[], ph: DataViewPagePlaceholders | undefined) =>
      view.rerender(
        <PluginProvider plugins={[plugin]}>
          <div data-scroller style={{ overflowY: "auto" }}>
            <GalleryView {...props(next, ph)} />
          </div>
        </PluginProvider>,
      ),
  };
}

const card = (key: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${key}"]`)!;
/** The column a card sits in: its cell's index among its grid's cells. */
const columnOf = (key: string) => {
  const cell = card(key).closest(".contents")!;
  return [...cell.parentElement!.children].indexOf(cell) % COLUMNS;
};
const spacers = () => [...document.querySelectorAll("[data-grid-pad]")];

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // The probe resolves 4 tracks (and every box is 800 px wide).
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const style = computed(el, pseudo);
    Object.defineProperty(style, "gridTemplateColumns", {
      configurable: true,
      value: Array.from({ length: COLUMNS }, () => "200px").join(" "),
    });
    return style;
  });
  // Every element is laid out 100 px tall and the scroller 10 000 px, so a
  // windowed gallery mounts every line.
  const heightOf = (el: Element) =>
    el.hasAttribute("data-scroller") ? 10_000 : 100;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const h = heightOf(this);
      return { top: 0, bottom: h, height: h, width: 800 } as DOMRect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return heightOf(this);
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("gallery: a release above keeps every card's column", () => {
  it("plain grid: a page released mid-line pads the band, and the landing removes the pad", () => {
    const view = mount(rowsOf(0, 10), NONE);
    const before = rowsOf(5, 10).map((r) => columnOf(r.id));
    expect(before).toEqual([1, 2, 3, 0, 1]);
    expect(spacers()).toHaveLength(0);

    // Rows 0–4 released: the first surviving card stays in column 1.
    view.update(rowsOf(5, 10), releasedAbove(5));
    expect(rowsOf(5, 10).map((r) => columnOf(r.id))).toEqual(before);
    // One spacer, never a row the viewport or anchoring could see.
    expect(spacers()).toHaveLength(1);
    expect(spacers()[0]!.hasAttribute("data-row-key")).toBe(false);

    // The page lands back: the band starts at the read's head again.
    view.update(rowsOf(0, 10), NONE);
    expect(rowsOf(5, 10).map((r) => columnOf(r.id))).toEqual(before);
    expect(spacers()).toHaveLength(0);
  });

  it("with nothing released above, a band missing its first cards starts at column 0", () => {
    // In memory (a client search), and a paged read at its head alike: the
    // rows drawn are the band's whole start, never a pad.
    const view = mount(rowsOf(0, 10), undefined);
    view.update(rowsOf(5, 10), undefined);
    expect(columnOf("r5")).toBe(0);
    const paged = mount(rowsOf(0, 10), NONE);
    paged.update(rowsOf(5, 10), NONE);
    expect(spacers()).toHaveLength(0);
  });

  it("windowed: a release keeps each card's column and the mounted lines' DOM", () => {
    const view = mount(rowsOf(0, 100), NONE);
    const keys = rowsOf(50, 100).map((r) => r.id);
    const columns = keys.map(columnOf);
    const nodes = keys.map(card);
    expect(nodes.every((n) => n !== null)).toBe(true);

    // Page 0 (50 cards — a boundary mid-line) released.
    view.update(rowsOf(50, 100), releasedAbove(50));
    expect(keys.map(columnOf)).toEqual(columns);
    // Lines keyed by absolute line: the surviving cards were never remounted.
    expect(keys.map(card)).toEqual(nodes);
    expect(spacers()).toHaveLength(2);

    view.update(rowsOf(0, 100), NONE);
    expect(keys.map(columnOf)).toEqual(columns);
    expect(keys.map(card)).toEqual(nodes);
  });
});
