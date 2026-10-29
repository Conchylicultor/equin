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

/**
 * A column header offers sort on exactly the host's sortable fields
 * (`sortHeader.sortable`), never on every field that shows a value: under a
 * live source a field may show a value its list cannot be ordered by, and a
 * click there would persist a rule that replaces the list with its error. The
 * arrow reads the ACTIVE sort (`sortHeader.active`), which a server-ordered
 * source keeps even though `state.sort` is emptied.
 */

const plugin = {
  id: "data-view-table-header-sort-test",
  description: "table header-sort fixture",
  contributions: [],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; url: string };

const FIELDS: FieldDef<Row>[] = [
  { id: "name", label: "Name", type: "plain", value: (r) => r.name },
  { id: "url", label: "Link", type: "plain", value: (r) => r.url },
];

afterEach(cleanup);

function renderTable(setSort: (fieldId: string) => void) {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    placement: {},
    rows: [{ id: "1", name: "alpha", url: "https://a" }],
    fields: FIELDS,
    rowKey: (r) => r.id,
    // Server-ordered: the pipeline's sort is empty, the active one is not.
    state: { sort: [], query: "", filter: null },
    setSort,
    sortHeader: {
      active: [{ fieldId: "name", direction: "asc" }],
      sortable: new Set(["name"]),
    },
    setFilter: () => {},
    setExpanded: () => {},
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    options: undefined,
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <TableView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

describe("data-view table header sort", () => {
  it("toggles sort only on a sortable field", () => {
    const setSort = vi.fn();
    const { getByText } = renderTable(setSort);
    fireEvent.click(getByText("Link"));
    expect(setSort).not.toHaveBeenCalled();
    fireEvent.click(getByText("Name"));
    expect(setSort).toHaveBeenCalledWith("name");
  });

  it("draws the sort affordance on sortable headers only, active from the active sort", () => {
    const { getByText } = renderTable(() => {});
    const icon = (label: string) => getByText(label).querySelector("svg");
    expect(icon("Link")).toBeNull();
    // The active rule lights the Name arrow although `state.sort` is empty.
    expect(icon("Name")?.getAttribute("data-icon")).toMatch(/upward/);
    expect(icon("Name")?.getAttribute("class")).toContain("text-foreground");
  });

  it("marks each row with its row key, like the list and icons views", () => {
    const { getByText } = renderTable(() => {});
    expect(
      getByText("alpha")
        .closest("[data-row-key]")
        ?.getAttribute("data-row-key"),
    ).toBe("1");
  });
});
