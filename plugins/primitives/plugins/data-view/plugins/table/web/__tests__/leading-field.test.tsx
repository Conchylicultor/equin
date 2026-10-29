import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  DataViewSlots,
  type DataViewRenderProps,
  type FieldDef,
  type TableCellProps,
} from "@plugins/primitives/plugins/data-view/web";
import { TableView } from "../components/table-view";

/**
 * A field placed in `lead` is the table's first column, its `data` drawn by its
 * type's cell. Local fixture cell for a
 * synthetic type (no `fields/*` import: that is a cycle).
 */
function SpecCell(props: TableCellProps) {
  return <span data-testid="spec-cell">{String(props.data)}</span>;
}

const plugin = {
  id: "data-view-table-leading-field-test",
  description: "table leading-field fixture",
  contributions: [DataViewSlots.Cell({ match: "spec", component: SpecCell })],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; glyph: string };

const FIELDS: FieldDef<Row>[] = [
  { id: "name", label: "Name", type: "plain", value: (r) => r.name },
  {
    id: "avatar",
    label: "Avatar",
    type: "spec",
    data: (r) => r.glyph,
  },
];

afterEach(cleanup);

describe("data-view table lead field", () => {
  it("renders the lead field as the first column", () => {
    const props: DataViewRenderProps<Row> = {
      revealSelection: true,
      placement: { place: { avatar: "lead" } },
      rows: [{ id: "1", name: "alpha", glyph: "★" }],
      fields: FIELDS,
      rowKey: (r) => r.id,
      state: { sort: [], query: "", filter: null },
      setSort: () => {},
      sortHeader: { active: [], sortable: new Set<string>() },
      setFilter: () => {},
      setExpanded: () => {},
      // Grouping inputs. These fixtures render UNGROUPED, so the clock is never
      // consulted — a pinned zero states that rather than borrowing the real one.
      now: 0,
      groupOrder: "asc",
      rowsComplete: true,
      sectioning: { kind: "bucket" },
      options: undefined,
    };
    const { getByText, getByTestId } = render(
      <PluginProvider plugins={[plugin]}>
        <TableView {...(props as DataViewRenderProps<unknown>)} />
      </PluginProvider>,
    );
    const header = getByText("Avatar");
    const cell = getByTestId("spec-cell");
    expect(cell.textContent).toBe("★");
    // The lead is the first column: its header and cell come before Name's.
    expect(
      header.compareDocumentPosition(getByText("Name")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      cell.compareDocumentPosition(getByText("alpha")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
