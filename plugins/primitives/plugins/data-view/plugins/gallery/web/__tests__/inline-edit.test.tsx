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
} from "@plugins/primitives/plugins/data-view/web";
import { GalleryView } from "../components/gallery-view";

// Minimal local inline editor (a bare input) contributed for `type:"text"` —
// keeps the fixture self-contained (no cross-plugin field imports).
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

const plugin = {
  id: "data-view-gallery-inline-edit-test",
  description: "gallery inline-edit fixture",
  contributions: [
    DataViewSlots.CellEditor({ match: "text", component: LocalTextEditor }),
  ],
  // The rendered slots must be declared for their ids to exist.
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name?: string };

function renderProps(
  fields: FieldDef<Row>[],
  rows: Row[] = [{ id: "1", name: "alpha" }],
): DataViewRenderProps<Row> {
  return {
    revealSelection: true,
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

describe("data-view gallery inline cell editing", () => {
  it("edits a card field whose field declares onEdit", () => {
    const onEdit = vi.fn();
    const { getByText, getByLabelText } = render(
      <PluginProvider plugins={[plugin]}>
        <GalleryView
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

    // The value belongs to the card's own click; the hover-revealed pencil is
    // what opens the editor.
    expect(getByText("alpha")).toBeTruthy();
    fireEvent.click(getByLabelText("Edit Name"));
    const input = getByLabelText("cell-editor");
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith({ id: "1", name: "alpha" }, "beta");
  });

  it("does not enter edit mode for a card field without onEdit", () => {
    const { getByText, queryByLabelText } = render(
      <PluginProvider plugins={[plugin]}>
        <GalleryView
          {...(renderProps([
            { id: "name", label: "Name", type: "text", value: (r) => r.name },
          ]) as DataViewRenderProps<unknown>)}
        />
      </PluginProvider>,
    );

    fireEvent.click(getByText("alpha"));
    expect(queryByLabelText("cell-editor")).toBeNull();
    expect(queryByLabelText("Edit Name")).toBeNull();
  });

  it('omits an empty value — never an italic "Empty"', () => {
    const { container, getByText } = render(
      <PluginProvider plugins={[plugin]}>
        <GalleryView
          {...(renderProps(
            [
              {
                id: "name",
                label: "Name",
                type: "text",
                primary: true,
                value: (r) => r.name,
              },
              {
                id: "note",
                label: "Note",
                type: "text",
                value: (r) => (r.id === "2" ? undefined : "memo"),
                onEdit: vi.fn(),
              },
            ],
            [
              { id: "1", name: "alpha" },
              { id: "2", name: "beta" },
            ],
          ) as DataViewRenderProps<unknown>)}
        />
      </PluginProvider>,
    );
    expect(getByText("memo")).toBeTruthy();
    expect(getByText("beta")).toBeTruthy();
    expect(container.textContent).not.toContain("Empty");
  });
});
