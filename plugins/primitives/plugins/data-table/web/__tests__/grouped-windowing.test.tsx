import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DataTable, VIRTUALIZE_THRESHOLD } from "../internal/data-table";
import type { ColumnDef, DataTableGroup } from "../internal/types";

// Grouped mode windows per group: a group past the threshold draws only its
// window (jsdom has no viewport, so at most the probe row), while every header
// — and a small group's rows — stay drawn.

type Row = { id: string };
const columns: ColumnDef<Row>[] = [
  { id: "id", header: "Id", value: (r) => r.id },
];

const BIG = VIRTUALIZE_THRESHOLD * 3;

function groups(): DataTableGroup<Row>[] {
  return [
    {
      key: "big",
      header: "Big",
      collapsed: false,
      rows: Array.from({ length: BIG }, (_, i) => ({ id: `b${i}` })),
    },
    {
      key: "small",
      header: "Small",
      collapsed: false,
      rows: [{ id: "s1" }, { id: "s2" }],
    },
  ];
}

const drawn = (prefix: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-row-key]")].filter((el) =>
    el.dataset.rowKey!.startsWith(prefix),
  ).length;

afterEach(cleanup);

describe("DataTable grouped windowing", () => {
  it("windows a group past the threshold and keeps every header mounted", () => {
    render(
      // The scroller a window binds to (jsdom has no document scroller).
      <div style={{ overflowY: "auto" }}>
        <DataTable
          data={[]}
          columns={columns}
          groups={groups()}
          rowKey={(r) => r.id}
        />
      </div>,
    );
    expect(drawn("b")).toBeLessThan(BIG);
    expect(drawn("s")).toBe(2);
    const host = document.querySelector("[data-row-fold-host]")!;
    const folds = [...host.children]
      .map((el) => (el as HTMLElement).dataset.rowFold)
      .filter((k) => k !== undefined);
    expect(folds).toContain("\u0000group:big");
    expect(folds).toContain("\u0000group:small");
  });

  it("draws a group at the threshold in full", () => {
    render(
      <DataTable
        data={[]}
        columns={columns}
        groups={[
          {
            key: "g",
            header: "G",
            collapsed: false,
            rows: Array.from({ length: VIRTUALIZE_THRESHOLD }, (_, i) => ({
              id: `r${i}`,
            })),
          },
        ]}
        rowKey={(r) => r.id}
      />,
    );
    expect(drawn("r")).toBe(VIRTUALIZE_THRESHOLD);
  });
});
