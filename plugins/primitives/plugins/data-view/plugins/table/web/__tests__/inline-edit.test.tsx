import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  DataViewSlots,
  type CellEditorProps,
  type DataViewRenderProps,
  type FieldDef,
  type TableCellProps,
} from "@plugins/primitives/plugins/data-view/web";
import { TableView } from "../components/table-view";

// A minimal local inline editor (a bare input) contributed for `type:"text"`.
// Keeping the fixture self-contained means the test depends only on the table
// plugin's own components + the data-view barrel — no cross-plugin field imports
// (which would form a data-view ⇄ fields cycle).
function LocalTextEditor(props: CellEditorProps): ReactNode {
  const [v, setV] = useState(props.value == null ? "" : String(props.value));
  return (
    <input
      autoFocus
      aria-label="cell-editor"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") props.onCommit(v === "" ? null : v);
        else if (e.key === "Escape") props.onCancel();
      }}
    />
  );
}

// A minimal multi-value (tags-style) fixture for `type:"multi"`: the read cell
// reads the threaded `TableCellProps.values`; the editor commits a new array via
// the multi-value commit channel (`onCommitValues`).
function LocalMultiCell(props: TableCellProps): ReactNode {
  return <span>{(props.values ?? []).join(",")}</span>;
}
function LocalMultiEditor(props: CellEditorProps): ReactNode {
  return (
    <button
      aria-label="multi-cell-editor"
      onClick={() => props.onCommitValues([...(props.values ?? []), "added"])}
    >
      commit
    </button>
  );
}

const plugin = {
  id: "data-view-table-inline-edit-test",
  description: "inline-edit fixture",
  contributions: [
    DataViewSlots.CellEditor({ match: "text", component: LocalTextEditor }),
    DataViewSlots.Cell({ match: "multi", component: LocalMultiCell }),
    DataViewSlots.CellEditor({ match: "multi", component: LocalMultiEditor }),
  ],
  // The rendered slots must be declared for their ids to exist.
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name?: string; tags?: string[] };

function renderProps(
  fields: FieldDef<Row>[],
  rows: Row[] = [{ id: "1", name: "alpha" }],
): DataViewRenderProps<Row> {
  return {
    revealSelection: true,
    placement: {},
    rows,
    fields,
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
}

afterEach(cleanup);

describe("data-view table inline cell editing", () => {
  it("edits a cell whose field declares onEdit", () => {
    const onEdit = vi.fn();
    const { getByText, getByLabelText } = render(
      <PluginProvider plugins={[plugin]}>
        <TableView
          {...(renderProps([
            {
              id: "name",
              label: "Name",
              type: "text",
              value: (r) => r.name,
              onEdit,
            },
          ]) as DataViewRenderProps<unknown>)}
        />
      </PluginProvider>,
    );

    // The value itself is transparent to the click (it belongs to the row);
    // the hover-revealed pencil is the way in.
    expect(getByText("alpha")).toBeTruthy();
    fireEvent.click(getByLabelText("Edit Name"));
    const input = getByLabelText("cell-editor");
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith({ id: "1", name: "alpha" }, "beta");
  });

  it("edits an EMPTY editable cell via its 'Empty' hint affordance", () => {
    const onEdit = vi.fn();
    const { getByText, getByLabelText } = render(
      <PluginProvider plugins={[plugin]}>
        <TableView
          {...(renderProps(
            [
              {
                id: "name",
                label: "Name",
                type: "text",
                value: (r) => r.name || null,
                onEdit,
              },
            ],
            [{ id: "1", name: "" }],
          ) as DataViewRenderProps<unknown>)}
        />
      </PluginProvider>,
    );

    // An empty cell still presents its hint AND its pencil, instead of
    // collapsing to a zero-size void with nothing to aim at.
    expect(getByText("Empty")).toBeTruthy();
    fireEvent.click(getByLabelText("Edit Name"));
    const input = getByLabelText("cell-editor");
    fireEvent.change(input, { target: { value: "filled" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith({ id: "1", name: "" }, "filled");
  });

  it("never enters edit mode for a field without onEdit", () => {
    const { getByText, queryByLabelText } = render(
      <PluginProvider plugins={[plugin]}>
        <TableView
          {...(renderProps([
            { id: "name", label: "Name", type: "text", value: (r) => r.name },
          ]) as DataViewRenderProps<unknown>)}
        />
      </PluginProvider>,
    );

    fireEvent.click(getByText("alpha"));
    expect(queryByLabelText("cell-editor")).toBeNull();
    // …and there is no pencil to click either.
    expect(queryByLabelText("Edit Name")).toBeNull();
  });

  it("edits a multi-value cell via the onCommitValues → onEditValues channel", () => {
    const onEditValues = vi.fn();
    const { getByText, getByLabelText } = render(
      <PluginProvider plugins={[plugin]}>
        <TableView
          {...(renderProps(
            [
              {
                id: "tags",
                label: "Tags",
                type: "multi",
                values: (r) => r.tags ?? [],
                onEditValues,
              },
            ],
            [{ id: "1", tags: ["a"] }],
          ) as DataViewRenderProps<unknown>)}
        />
      </PluginProvider>,
    );

    // The read cell renders the threaded `TableCellProps.values`.
    expect(getByText("a")).toBeTruthy();
    fireEvent.click(getByLabelText("Edit Tags"));
    fireEvent.click(getByLabelText("multi-cell-editor"));

    expect(onEditValues).toHaveBeenCalledTimes(1);
    expect(onEditValues).toHaveBeenCalledWith({ id: "1", tags: ["a"] }, [
      "a",
      "added",
    ]);
  });

  it("edits an EMPTY multi-value cell via its 'Empty' hint affordance", () => {
    const onEditValues = vi.fn();
    const { getByText, getByLabelText } = render(
      <PluginProvider plugins={[plugin]}>
        <TableView
          {...(renderProps(
            [
              {
                id: "tags",
                label: "Tags",
                type: "multi",
                values: (r) => r.tags ?? [],
                onEditValues,
              },
            ],
            [{ id: "1", tags: [] }],
          ) as DataViewRenderProps<unknown>)}
        />
      </PluginProvider>,
    );

    // An empty multi-value cell shows the hint (not a zero-size void) beside
    // its pencil.
    expect(getByText("Empty")).toBeTruthy();
    fireEvent.click(getByLabelText("Edit Tags"));
    fireEvent.click(getByLabelText("multi-cell-editor"));

    expect(onEditValues).toHaveBeenCalledTimes(1);
    expect(onEditValues).toHaveBeenCalledWith({ id: "1", tags: [] }, ["added"]);
  });

  it("lets a click on the VALUE reach the row, and keeps the pencil off it", () => {
    const onEdit = vi.fn();
    const activate = vi.fn();
    const { getByText, getByLabelText, queryByLabelText } = render(
      <PluginProvider plugins={[plugin]}>
        <TableView
          {...({
            ...renderProps([
              {
                id: "name",
                label: "Name",
                type: "text",
                value: (r: Row) => r.name,
                onEdit,
              },
            ]),
            rowActivation: () => activate,
          } as DataViewRenderProps<unknown>)}
        />
      </PluginProvider>,
    );

    // The row owns clicks on its own content: the text opens the record.
    fireEvent.click(getByText("alpha"));
    expect(activate).toHaveBeenCalledTimes(1);
    expect(queryByLabelText("cell-editor")).toBeNull();

    // The pencil is the ONLY way into the editor, and it never activates the
    // row it is editing in.
    fireEvent.click(getByLabelText("Edit Name"));
    expect(activate).toHaveBeenCalledTimes(1);
    expect(getByLabelText("cell-editor")).toBeTruthy();
  });

  it("makes a link row's ⌘- / middle-click open its href in a browser tab", () => {
    const open = vi.fn();
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    const { getByText } = render(
      <PluginProvider plugins={[plugin]}>
        <TableView
          {...({
            ...renderProps([
              {
                id: "name",
                label: "Name",
                type: "text",
                value: (r: Row) => r.name,
              },
            ]),
            rowActivation: (r: Row) => ({
              open: () => open(r.id),
              href: () => `/rows/${r.id}`,
            }),
          } as DataViewRenderProps<unknown>)}
        />
      </PluginProvider>,
    );
    const row = getByText("alpha").closest<HTMLElement>("[role='button']")!;

    fireEvent.click(row);
    expect(open).toHaveBeenCalledWith("1");
    expect(windowOpen).not.toHaveBeenCalled();

    fireEvent.click(row, { metaKey: true });
    fireEvent(row, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(windowOpen).toHaveBeenCalledTimes(2);
    expect(String(windowOpen.mock.calls[1]![0])).toBe(
      `${window.location.origin}/rows/1`,
    );

    // Keyboard activation runs the plain open.
    fireEvent.keyDown(row, { key: "Enter" });
    expect(open).toHaveBeenCalledTimes(2);
    windowOpen.mockRestore();
  });

  it("never enters edit mode for a multi-value field without onEditValues", () => {
    const { getByText, queryByLabelText } = render(
      <PluginProvider plugins={[plugin]}>
        <TableView
          {...(renderProps(
            [
              {
                id: "tags",
                label: "Tags",
                type: "multi",
                values: (r) => r.tags ?? [],
              },
            ],
            [{ id: "1", tags: ["a"] }],
          ) as DataViewRenderProps<unknown>)}
        />
      </PluginProvider>,
    );

    fireEvent.click(getByText("a"));
    expect(queryByLabelText("multi-cell-editor")).toBeNull();
    expect(queryByLabelText("Edit Tags")).toBeNull();
  });
});
