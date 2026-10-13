/**
 * A paged icons grid keeps every tile in the column it was drawn in when the
 * pages above it are released (turned into a placeholder) or land back: the
 * band starts with as many empty spacer cells as the released tiles' phase
 * (`useGridPhase`), the spacers are neither rows nor tiles (no
 * `data-row-key`, no role — the arrow keys skip them), and the windowed lanes
 * are keyed by absolute line — so a release keeps the mounted lanes' DOM. The
 * column count is stubbed through the probe's resolved grid tracks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
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
import { IconsView } from "../components/icons-view";

const plugin = {
  id: "data-view-icons-paged-phase-test",
  description: "icons paged-phase fixture",
  contributions: [],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name: string };
const name: FieldDef<Row> = {
  id: "name",
  label: "Name",
  type: "text",
  value: (r) => r.name,
  primary: true,
};

/** Tracks the probe resolves. */
const COLUMNS = 4;

const rowsOf = (from: number, to: number): Row[] =>
  Array.from({ length: to - from }, (_, i) => ({
    id: `r${from + i}`,
    name: `app ${from + i}`,
  }));

const NONE: DataViewPagePlaceholders = { before: [], after: [] };
const releasedAbove = (rows: number): DataViewPagePlaceholders => ({
  before: [{ key: "page:0", rows }],
  after: [],
});

function view(rows: Row[], placeholders: DataViewPagePlaceholders | undefined) {
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
    rowActivation: () => () => {},
    placeholders,
  };
  return (
    <PluginProvider plugins={[plugin]}>
      <div data-scroller style={{ overflowY: "auto" }}>
        <IconsView {...(p as DataViewRenderProps<unknown>)} />
      </div>
    </PluginProvider>
  );
}

const tile = (key: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${key}"]`)!;
/** The column a tile sits in: its cell's index among its grid's cells. */
const columnOf = (key: string) => {
  const cell = tile(key).parentElement!;
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
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const style = real(el, pseudo);
    return new Proxy(style, {
      get: (target, prop) =>
        prop === "gridTemplateColumns"
          ? Array(COLUMNS).fill("116px").join(" ")
          : Reflect.get(target, prop, target),
    });
  });
  // Every element 100 px tall, the scroller 10 000 px: a windowed grid mounts
  // every lane.
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

describe("icons: a release above keeps every tile's column", () => {
  it("plain grid: a page released mid-line pads the band; the arrow keys skip the pad", () => {
    const { rerender } = render(view(rowsOf(0, 10), NONE));
    const before = rowsOf(6, 10).map((r) => columnOf(r.id));
    expect(before).toEqual([2, 3, 0, 1]);

    rerender(view(rowsOf(6, 10), releasedAbove(6)));
    expect(rowsOf(6, 10).map((r) => columnOf(r.id))).toEqual(before);
    expect(spacers()).toHaveLength(2);
    for (const s of spacers()) {
      expect(s.hasAttribute("data-row-key")).toBe(false);
      expect(s.hasAttribute("role")).toBe(false);
    }
    // Home from the second tile lands on the first TILE, never a spacer.
    tile("r7").focus();
    fireEvent.keyDown(tile("r7"), { key: "Home" });
    expect(document.activeElement).toBe(tile("r6"));

    rerender(view(rowsOf(0, 10), NONE));
    expect(rowsOf(6, 10).map((r) => columnOf(r.id))).toEqual(before);
    expect(spacers()).toHaveLength(0);
  });

  it("windowed: a release keeps each tile's column and the mounted lanes' DOM", () => {
    const { rerender } = render(view(rowsOf(0, 200), NONE));
    const keys = rowsOf(130, 200).map((r) => r.id);
    const columns = keys.map(columnOf);
    const nodes = keys.map(tile);
    expect(nodes.every((n) => n !== null)).toBe(true);

    // Page 0 (50 tiles — a boundary mid-line) released; 150 left, still windowed.
    rerender(view(rowsOf(50, 200), releasedAbove(50)));
    expect(keys.map(columnOf)).toEqual(columns);
    expect(keys.map(tile)).toEqual(nodes);
    expect(spacers()).toHaveLength(2);

    rerender(view(rowsOf(0, 200), NONE));
    expect(keys.map(columnOf)).toEqual(columns);
    expect(keys.map(tile)).toEqual(nodes);
  });
});
