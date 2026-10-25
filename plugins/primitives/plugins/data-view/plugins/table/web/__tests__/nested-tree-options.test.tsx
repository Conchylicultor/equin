import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  DataViewSlots,
  defineItemActions,
  type DataViewRenderProps,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type { ViewExpandAll } from "@plugins/primitives/plugins/data-view/core";
import { useOptionalRowControls } from "@plugins/primitives/plugins/tree/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { TableView } from "../components/table-view";
import type { TableViewOptions } from "../../core";

/**
 * The tree view's options, carried by the nested table (tree-table plan P4):
 * the row menu, the persistent `trailing`, the label class, the row accent,
 * the root Add, the expand-all it reports up to the host — and the tree row's controls reaching
 * whatever renders inside a table row (`useOptionalRowControls`).
 */

type Row = { id: string; parent: string | null; name: string; size: string };

const ROWS: Row[] = [
  { id: "src", parent: null, name: "src", size: "—" },
  { id: "lib", parent: "src", name: "lib", size: "—" },
  { id: "readme", parent: null, name: "README.md", size: "2 KB" },
];

const fields: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "plain",
    primary: true,
    value: (r) => r.name,
  },
  { id: "size", label: "Size", type: "plain", value: (r) => r.size },
];

/** An item action that reports whether it sits inside a tree row. */
function ControlsProbe({ row }: { row: Row }) {
  const controls = useOptionalRowControls();
  return (
    <span data-testid={`probe-${row.id}`}>
      {controls ? "controls" : "none"}
    </span>
  );
}

const Actions = defineItemActions<Row>();
const plugin = {
  id: "data-view-table-nested-tree-options-test",
  description: "nested table tree-options fixture",
  contributions: [Actions({ id: "probe", component: ControlsProbe })],
  slots: { ...DataViewSlots, actions: Actions },
} as unknown as LoadedPlugin;

function renderTable(
  options: TableViewOptions<Row>,
  over: Partial<DataViewRenderProps<Row>> = {},
  onCreate?: () => Promise<string | null>,
) {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    rows: ROWS,
    fields,
    rowKey: (r) => r.id,
    state: { sort: [], query: "", filter: null },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: () => {},
    expanded: { src: true },
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    hierarchy: {
      getParentId: (r) => r.parent,
      getRank: (r) => Rank.from(r.id === "readme" ? "a1" : "a0"),
      onCreate,
    },
    options,
    ...over,
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <TableView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

const rowOf = (getByText: (t: string) => HTMLElement, label: string) =>
  getByText(label).closest<HTMLElement>("[data-tree-row]")!;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

describe("data-view nested table: tree options", () => {
  it("publishes the tree row's controls to what renders inside a row", () => {
    const { getByTestId, getByText } = renderTable(
      { presentation: "outline" },
      { itemActions: Actions },
    );
    // An outline's cluster overlays its row and mounts when the row is
    // reached, as a tree row's does.
    fireEvent.pointerOver(getByText("src"));
    fireEvent.pointerOver(getByText("README.md"));
    expect(getByTestId("probe-src").textContent).toBe("controls");
    expect(getByTestId("probe-readme").textContent).toBe("controls");
  });

  it("draws the row menu in the row's cluster, built with the row", () => {
    const { getByText } = renderTable({
      rowMenu: (_helpers, row) => [
        { label: `Below ${row.name}`, onClick: () => {} },
      ],
    });
    expect(
      rowOf(getByText, "README.md").querySelector(
        "[aria-label='More actions']",
      ),
    ).not.toBeNull();
  });

  it("puts `trailing` at rest after every column, at the row's end", () => {
    const { getByText, getByTestId } = renderTable({
      trailing: (r) => <span data-testid={`badge-${r.id}`}>{r.id}!</span>,
    });
    const badge = getByTestId("badge-readme");
    expect(badge.closest("[data-tree-row]")).toBe(
      rowOf(getByText, "README.md"),
    );
    // After the Size cell, as a tree row puts it after its chips.
    expect(
      getByText("2 KB").compareDocumentPosition(badge) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("classes the first column's label, and paints the row accent", () => {
    const { getByText } = renderTable({
      labelClassName: (r) =>
        r.id === "readme" ? ("line-through" as never) : undefined,
      rowAccent: (r) =>
        r.id === "readme" ? <span data-testid="wash" /> : null,
    });
    expect(getByText("README.md").closest(".line-through")).not.toBeNull();
    expect(getByText("src").closest(".line-through")).toBeNull();
    const row = rowOf(getByText, "README.md");
    expect(
      row.querySelector("[data-testid='wash']")?.parentElement?.className,
    ).toContain("absolute inset-0");
  });

  it("offers the root Add when the hierarchy can create, unless hidden", async () => {
    const create = async () => null;
    const shown = renderTable({ addLabel: "Agent" }, {}, create);
    expect(shown.getByRole("button", { name: "Agent" })).toBeTruthy();
    cleanup();
    const hidden = renderTable({ addLabel: null }, {}, create);
    expect(hidden.queryByRole("button", { name: "Add" })).toBeNull();
    cleanup();
    const readOnly = renderTable({});
    expect(readOnly.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("reports its expand-all up to the host instead of drawing a toolbar row", () => {
    const reports: (ViewExpandAll | null)[] = [];
    const { queryByRole, unmount } = renderTable(
      { expandAll: true },
      { reportExpandAll: (s) => reports.push(s) },
    );
    // No band above the rows: the DataView toolbar draws the control.
    expect(queryByRole("button", { name: /expand all|collapse all/i })).toBe(
      null,
    );
    // `src` (the one row with a child) is open → all expanded; folding writes
    // just that row.
    const last = reports.at(-1)!;
    expect(last.allExpanded).toBe(true);
    expect(last.changes(false)).toEqual([{ id: "src", expanded: false }]);
    expect(last.changes(true)).toEqual([]);
    unmount();
    expect(reports.at(-1)).toBe(null);
  });

  it("reports no expand-all unless asked, or with nothing to fold", () => {
    const unasked: (ViewExpandAll | null)[] = [];
    renderTable({}, { reportExpandAll: (s) => unasked.push(s) });
    expect(unasked.every((s) => s === null)).toBe(true);
    cleanup();
    const flat: (ViewExpandAll | null)[] = [];
    renderTable(
      { expandAll: true },
      {
        rows: ROWS.filter((r) => r.id !== "lib"),
        reportExpandAll: (s) => flat.push(s),
      },
    );
    expect(flat.every((s) => s === null)).toBe(true);
  });
});
