import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { DataTable, VIRTUALIZE_THRESHOLD } from "../internal/data-table";
import type { ColumnDef } from "../internal/types";

// A windowed row is found by its key, never handed its position: a row
// leaving above them re-renders none of the rows still drawn below it.
// (Handed its index, every drawn row below re-rendered — its `data-index`
// changed — and so did its cells.)

type Row = { id: string };

/** Each row's cell renders, by row id. */
const renders = new Map<string, number>();

const columns: ColumnDef<Row>[] = [
  {
    id: "id",
    header: "Id",
    value: (r) => r.id,
    cell: (r) => {
      renders.set(r.id, (renders.get(r.id) ?? 0) + 1);
      return r.id;
    },
  },
];

function Table({ rows }: { rows: Row[] }): ReactElement {
  return (
    <div data-scroller style={{ overflowY: "auto" }}>
      <DataTable data={rows} columns={columns} rowKey={(r) => r.id} />
    </div>
  );
}

/** Lay the page out: the scroller shows 300 px, a row is 31 px. */
function stubLayout(): void {
  const heightOf = (el: Element) =>
    el.hasAttribute("data-row-key")
      ? 31
      : el.hasAttribute("data-scroller")
        ? 300
        : 0;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const h = heightOf(this);
      return { top: 0, bottom: h, height: h, width: 100 } as DOMRect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return heightOf(this);
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return heightOf(this);
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
}

const drawnIds = () =>
  [...document.querySelectorAll<HTMLElement>("[data-row-key]")].map(
    (el) => el.dataset.rowKey!,
  );

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  renders.clear();
});

describe("DataTable windowed rows", () => {
  it("a row leaving above re-renders none of the windowed rows below it", () => {
    stubLayout();
    const rows = Array.from({ length: VIRTUALIZE_THRESHOLD * 3 }, (_, i) => ({
      id: `r${i}`,
    }));
    const view = render(<Table rows={rows} />);
    const before = drawnIds();
    // Windowed: a window's worth of rows, not all of them.
    expect(before.length).toBeGreaterThan(5);
    expect(before.length).toBeLessThan(rows.length);
    // Every drawn row carries its key for the window, never its index.
    for (const el of document.querySelectorAll("[data-row-key]")) {
      expect(el.getAttribute("data-virtual-key")).toBe(
        el.getAttribute("data-row-key"),
      );
      expect(el.hasAttribute("data-index")).toBe(false);
    }
    renders.clear();
    act(() => view.rerender(<Table rows={rows.slice(1)} />));
    const after = drawnIds();
    const stayed = before.filter((id) => id !== "r0" && after.includes(id));
    expect(stayed.length).toBeGreaterThan(5);
    for (const id of stayed) expect(renders.get(id) ?? 0).toBe(0);
  });
});
