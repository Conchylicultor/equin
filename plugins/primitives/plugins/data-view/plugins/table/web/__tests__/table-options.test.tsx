import { describe, it, expect, afterEach, vi } from "vitest";
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
import { TableView } from "../components/table-view";
import type { TableViewOptions } from "../../core";

/**
 * The table's surface options: where the column labels sit
 * (`viewOptions.table.columnHeader`), unlabelled columns (`FieldDef.header:
 * false`), the surface's `density`, and its group headers.
 */

const plugin = {
  id: "data-view-table-options-test",
  description: "table options fixture",
  contributions: [],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = {
  id: string;
  section: string;
  phase: string;
  title: string;
  waited: number;
};

const ROWS: Row[] = [
  { id: "1", section: "Queue", phase: "W", title: "alpha", waited: 3 },
  { id: "2", section: "Queue", phase: "Q", title: "beta", waited: 5 },
  { id: "3", section: "Build", phase: "H", title: "gamma", waited: 7 },
];

const FIELDS: FieldDef<Row>[] = [
  {
    id: "section",
    label: "Section",
    type: "plain",
    value: (r) => r.section,
    groupable: true,
    visible: false,
  },
  {
    id: "phase",
    label: "Phase",
    header: false,
    type: "plain",
    value: (r) => r.phase,
  },
  {
    id: "title",
    label: "Title",
    header: false,
    type: "plain",
    value: (r) => r.title,
  },
  {
    id: "waited",
    label: "Waited",
    header: "waited",
    type: "plain",
    value: (r) => r.waited,
  },
];

afterEach(cleanup);

function renderTable(
  overrides: Partial<DataViewRenderProps<Row>> & {
    options?: TableViewOptions;
    grouped?: boolean;
  } = {},
) {
  const { grouped = true, ...rest } = overrides;
  const setSort = vi.fn();
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    rows: ROWS,
    fields: FIELDS,
    rowKey: (r) => r.id,
    state: {
      sort: [],
      query: "",
      filter: null,
      groupBy: grouped
        ? { fieldId: "section", groupingId: "value" }
        : undefined,
    },
    setSort,
    // Every field is header-sortable here (a client-side array source).
    sortHeader: { active: [], sortable: new Set(FIELDS.map((f) => f.id)) },
    setFilter: () => {},
    setExpanded: () => {},
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    options: undefined,
    ...rest,
  };
  const utils = render(
    <PluginProvider plugins={[plugin]}>
      <TableView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
  return { ...utils, setSort };
}

/** The subgrid row a cell's text sits in. */
function rowOf(el: HTMLElement): HTMLElement {
  const row = el.closest<HTMLElement>(".grid-cols-subgrid");
  if (!row) throw new Error("no subgrid row around the element");
  return row;
}

describe("data-view table: columnHeader", () => {
  it('"row" (default) renders one header row above the groups', () => {
    const { getAllByText, container } = renderTable();
    expect(getAllByText("waited")).toHaveLength(1);
    expect(
      container.querySelector('[data-slot="data-table-first-group-header"]'),
    ).toBeNull();
  });

  it('"first-group" puts the labels on the first group header, with no header row', () => {
    const { getAllByText, getByText, container, setSort } = renderTable({
      options: { columnHeader: "first-group" },
    });
    const bands = container.querySelectorAll(
      '[data-slot="data-table-first-group-header"]',
    );
    expect(bands).toHaveLength(1);
    const band = bands[0] as HTMLElement;
    // The label is rendered once, inside the first group's band — no header row.
    const labels = getAllByText("waited");
    expect(labels).toHaveLength(1);
    expect(band.contains(labels[0]!)).toBe(true);
    // The band is a subgrid row: label cell spanning the two unlabelled tracks,
    // then the labelled column's header in its own track.
    expect(band.className).toContain("grid-cols-subgrid");
    const labelCell = band.firstElementChild as HTMLElement;
    expect(labelCell.style.gridColumn).toBe("span 2");
    // Sections read in value order: "Build" first, and only it carries labels.
    expect(labelCell.textContent).toContain("Build");
    expect(band.textContent).not.toContain("Queue");
    expect(getByText("Queue")).toBeTruthy();
    // Sort-on-click is kept on the relocated label.
    fireEvent.click(labels[0]!);
    expect(setSort).toHaveBeenCalledWith("waited");
  });

  it('"first-group" ungrouped falls back to the header row', () => {
    const { getAllByText, container } = renderTable({
      grouped: false,
      options: { columnHeader: "first-group" },
    });
    expect(getAllByText("waited")).toHaveLength(1);
    expect(
      container.querySelector('[data-slot="data-table-first-group-header"]'),
    ).toBeNull();
  });
});

describe("data-view table: FieldDef.header", () => {
  it("header: false leaves the header cell empty but the column sortable", () => {
    const { queryByText, getByText, setSort } = renderTable({ grouped: false });
    expect(queryByText("Phase")).toBeNull();
    expect(queryByText("Title")).toBeNull();
    // The header row's cells, in column order: phase, title, waited.
    const headerRow = rowOf(getByText("waited"));
    const cells = Array.from(headerRow.children) as HTMLElement[];
    expect(cells.map((c) => c.textContent)).toEqual(["", "", "waited"]);
    fireEvent.click(cells[0]!);
    expect(setSort).toHaveBeenCalledWith("phase");
  });
});

describe("data-view table: density and group headers", () => {
  it("compact density pads rows with the compact row token", () => {
    const comfortable = renderTable({ grouped: false });
    expect(rowOf(comfortable.getByText("alpha")).className).toContain("py-row");
    expect(rowOf(comfortable.getByText("alpha")).className).not.toContain(
      "py-row-compact",
    );
    cleanup();
    const compact = renderTable({ grouped: false, density: "compact" });
    const row = rowOf(compact.getByText("alpha"));
    expect(row.className).toContain("py-row-compact");
    expect(rowOf(compact.getByText("waited")).className).toContain(
      "py-row-compact",
    );
  });

  it("group headers render the group role with the count in the label's run", () => {
    const table = renderTable();
    const label = table.getByText("Queue");
    const header = label.closest<HTMLElement>("[aria-expanded]");
    // The control's box (or the control itself) carries the `group` role class.
    const box = header?.closest<HTMLElement>(".text-group") ?? null;
    expect(box).not.toBeNull();
    // Count "2" sits right after the label, inside the same control.
    expect(header?.textContent).toContain("Queue2");
  });
});
