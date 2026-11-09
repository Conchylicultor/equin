import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { DataTable } from "../internal/data-table";
import type { ColumnDef, DataTableGroup } from "../internal/types";

// Nested groups (`parentKey`) past the sticky stack's cap: each group with
// sub-groups is a branch box spanning the tracks, so a nested header pins
// below its parent chain and leaves with its branch. (The pinning offsets are
// sticky-stack's `stickyStackTop`, unit-tested there: jsdom measures 0 and
// folds the calc.)

type Row = { id: string };
const columns: ColumnDef<Row>[] = [
  { id: "id", header: "Id", value: (r) => r.id },
];

const group = (
  key: string,
  parentKey?: string,
  collapsed = false,
): DataTableGroup<Row> => ({
  key,
  header: <span>{key}</span>,
  collapsed,
  rows: [{ id: `${key}-row` }],
  parentKey,
});

// Six groups: past the default cap of five, so siblings swap.
function groups(collapseApp = false): DataTableGroup<Row>[] {
  return [
    group("app", undefined, collapseApp),
    ...(collapseApp
      ? []
      : [group("web", "app"), group("home", "web"), group("chord", "app")]),
    group("x"),
    group("y"),
  ];
}

function Table({ collapseApp = false }: { collapseApp?: boolean }) {
  return (
    <DataTable
      data={[]}
      columns={columns}
      groups={groups(collapseApp)}
      rowKey={(r) => r.id}
    />
  );
}

const band = (label: string) =>
  screen.getByText(label).closest<HTMLElement>(".sticky")!;
const row = (key: string) =>
  document.querySelector<HTMLElement>(`[data-row-key="${key}"]`);

afterEach(cleanup);

describe("DataTable nested groups", () => {
  it("draws each group with sub-groups as a branch box over the tracks", () => {
    render(<Table />);
    const app = band("app").parentElement!;
    expect(app.className).toContain("grid-cols-subgrid");
    // app's branch holds its rows, its sub-groups and theirs; x is outside.
    expect(app.contains(row("app-row"))).toBe(true);
    expect(app.contains(band("home"))).toBe(true);
    expect(app.contains(row("chord-row"))).toBe(true);
    expect(app.contains(band("x"))).toBe(false);
    // A leaf group draws flat in its parent's branch, no box of its own.
    expect(band("chord").parentElement).toBe(app);
    expect(band("home").parentElement).toBe(band("web").parentElement);
  });

  it("folds a collapsed parent's rows inside its branch away", async () => {
    const { rerender } = render(<Table />);
    rerender(<Table collapseApp />);
    await waitFor(() => expect(row("home-row")).toBeNull());
    expect(row("x-row")).not.toBeNull();
  });
});
