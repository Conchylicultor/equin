import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DataTable } from "../internal/data-table";
import type { ColumnDef, DataTablePresentation } from "../internal/types";

// The `soft` look (token-sized borderless rows, a hairline between them, a
// picked / cased header, the frame on the rail) — and the grid look it must
// leave exactly as it was.

type Row = { id: string; n: number };
const columns: ColumnDef<Row>[] = [
  { id: "id", header: "Id", value: (r) => r.id },
  { id: "n", header: "N", value: (r) => r.n, align: "end" },
];
const data: Row[] = [
  { id: "a", n: 1 },
  { id: "b", n: 2 },
];

function renderTable(presentation: DataTablePresentation) {
  return render(
    <DataTable
      data={data}
      columns={columns}
      rowKey={(r) => r.id}
      presentation={presentation}
      sortState={{ columnId: "n", direction: "asc" }}
      onToggleSort={() => {}}
      parts={{ table: "t", headerRow: "h", row: "r", cell: "c" }}
    />,
  );
}

const header = () =>
  document.querySelector<HTMLElement>('[data-slot="data-table-header"]')!;
const row = (key: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${key}"]`)!;

afterEach(cleanup);

describe("DataTable soft presentation", () => {
  it("draws token-sized borderless rows that mark themselves for the hairline", () => {
    renderTable("soft");
    const r = row("a");
    expect(r.hasAttribute("data-soft-row")).toBe(true);
    expect(r.className).toContain("min-h-soft-row");
    expect(r.className).toContain("p-soft-row");
    expect(r.className).toContain("rounded-soft-row");
    expect(r.className).not.toContain("border-b");
    expect(r.className).not.toContain("rail-follow");
    // The hairline: only under another soft row, hidden around the hover.
    expect(r.className).toContain("[[data-soft-row]+&]:before:block");
    expect(r.className).toContain("[[data-soft-row]:hover+&]:before:hidden");
    // The cell pick's scope on the row, its class on each cell.
    expect(r.style.getPropertyValue("--role-pick")).toBe("var(--cell-role)");
    expect(
      r.querySelector<HTMLElement>('[data-part="c"]')!.className,
    ).toContain("text-caption");
  });

  it("draws one picked, cased header row; unsorted arrows follow sortIcon", () => {
    renderTable("soft");
    const h = header();
    expect(h.dataset.part).toBe("h");
    expect(h.className).toContain("h-soft-header");
    expect(h.className).not.toContain("border-b");
    expect(h.style.getPropertyValue("--role-pick")).toBe(
      "var(--column-header-role)",
    );
    const [idLabel, nLabel] = [...h.children] as HTMLElement[];
    expect(idLabel!.className).toContain(
      "[@container_style(--column-header-case:upper)]:uppercase",
    );
    expect(idLabel!.className).toContain("text-column-header-ink");
    expect(nLabel!.className).toContain("text-column-header-sorted-ink");
    expect(idLabel!.innerHTML).toContain("--sort-icon:sorted");
    expect(idLabel!.innerHTML).toContain(
      "[@container_style(--sort-icon:hover)]:group-hover/column-header:opacity-100",
    );
  });

  it("puts the box on the rail and owes its contents none", () => {
    renderTable("soft");
    const box = document.querySelector<HTMLElement>('[data-part="t"]')!;
    expect(box.getAttribute("style")).toContain("--pane-inset");
    expect(box.className).toContain("rounded-soft-frame");
    const grid = box.firstElementChild as HTMLElement;
    expect(grid.style.getPropertyValue("--rail-owed-start")).toBe("0px");
    expect(grid.className).toContain("gap-x-soft");
  });
});

describe("DataTable grid presentation (unchanged by soft)", () => {
  it("keeps its rule, rail and row look; its labels read the columnHeader tokens", () => {
    renderTable("grid");
    const h = header();
    // No hard-coded label look: the case, tracking, type and ink are tokens.
    expect(h.className).not.toMatch(/\buppercase\b|tracking-wider|text-3xs/);
    expect(h.className).toContain("border-b");
    expect(h.className).toContain("rail-follow");
    expect(h.style.getPropertyValue("--role-pick")).toBe(
      "var(--column-header-role)",
    );
    const [idLabel, nLabel] = [...h.children] as HTMLElement[];
    expect(idLabel!.className).toContain("tracking-column-header");
    expect(idLabel!.className).toContain("text-column-header-ink");
    expect(nLabel!.className).toContain("text-column-header-sorted-ink");
    const r = row("a");
    expect(r.hasAttribute("data-soft-row")).toBe(false);
    expect(r.className).toContain("border-b border-border/30 text-caption");
    expect(r.className).toContain("rail-follow");
    const box = document.querySelector<HTMLElement>('[data-part="t"]')!;
    expect(box.getAttribute("class")).toBe(null);
    expect(box.getAttribute("style")).toBe(null);
    expect(box.firstElementChild!.className).toBe("grid gap-x-sm");
  });
});
