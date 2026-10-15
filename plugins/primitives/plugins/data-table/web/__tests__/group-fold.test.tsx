import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { DataTable } from "../internal/data-table";
import type { ColumnDef, DataTableGroup } from "../internal/types";

// A group's collapse folds its rows out through `row-fold`: they stay drawn
// (inert) until the tween ends, then go. jsdom's `Element.prototype.animate`
// stub (test/setup.ts) finishes at once, so "until the tween ends" is the
// next animation frame.

type Row = { id: string };
const columns: ColumnDef<Row>[] = [
  { id: "id", header: "Id", value: (r) => r.id },
];

function groups(collapsed: boolean): DataTableGroup<Row>[] {
  return [
    {
      key: "g",
      header: "Group",
      collapsed,
      rows: [{ id: "r1" }, { id: "r2" }],
    },
    { key: "h", header: "Other", collapsed: false, rows: [{ id: "r3" }] },
  ];
}

function Table({ collapsed }: { collapsed: boolean }) {
  return (
    <DataTable
      data={[]}
      columns={columns}
      groups={groups(collapsed)}
      rowKey={(r) => r.id}
    />
  );
}

const row = (key: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${key}"]`);

afterEach(cleanup);

describe("DataTable group fold", () => {
  it("keeps a collapsed group's rows drawn and inert until they fold away", async () => {
    const { rerender } = render(<Table collapsed={false} />);
    expect(row("r1")!.hasAttribute("inert")).toBe(false);

    rerender(<Table collapsed />);
    expect(row("r1")!.hasAttribute("inert")).toBe(true);
    expect(row("r3")!.hasAttribute("inert")).toBe(false);
    await waitFor(() => expect(row("r1")).toBeNull());
    expect(row("r3")).not.toBeNull();
  });

  it("draws an expanded group's rows at once", () => {
    const { rerender } = render(<Table collapsed />);
    expect(row("r1")).toBeNull();
    rerender(<Table collapsed={false} />);
    expect(row("r1")).not.toBeNull();
  });

  it("every line is a direct child of the fold host", () => {
    render(<Table collapsed={false} />);
    const host = document.querySelector("[data-row-fold-host]")!;
    const keys = [...host.children]
      .map((el) => (el as HTMLElement).dataset.rowFold)
      .filter((k) => k !== undefined);
    expect(keys).toEqual(["\u0000group:g", "r1", "r2", "\u0000group:h", "r3"]);
  });
});
