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
import { ListView } from "../components/list-view";

/**
 * A field declaring `leading: true` renders in the row's leading slot — ahead
 * of the view's own `leading` option — and nowhere in the body. The cell is a
 * local fixture for a synthetic type (no `fields/*` import: that is a cycle).
 */
function SpecCell(props: TableCellProps) {
  return <span data-testid="spec-cell">{String(props.data)}</span>;
}

const plugin = {
  id: "data-view-list-leading-field-test",
  description: "list leading-field fixture",
  contributions: [DataViewSlots.Cell({ match: "spec", component: SpecCell })],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; glyph: string; note: string };

// The avatar comes FIRST and nothing is `primary`/`text`, so without the
// leading exclusion `pickPrimaryField`'s `fields[0]` fallback would title the
// row with it.
const avatar: FieldDef<Row> = {
  id: "avatar",
  label: "Avatar",
  type: "spec",
  data: (r) => r.glyph,
};
const name: FieldDef<Row> = {
  id: "name",
  label: "Name",
  type: "plain",
  value: (r) => r.name,
};
const note: FieldDef<Row> = {
  id: "note",
  label: "Note",
  type: "plain",
  value: (r) => r.note,
};

const ROW: Row = { id: "1", name: "alpha", glyph: "★", note: "memo" };

function renderList(
  fields: FieldDef<Row>[],
  opts: { properties?: string[]; own?: boolean } = {},
) {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    rows: [ROW],
    fields,
    rowKey: (r) => r.id,
    state: {
      sort: [],
      query: "",
      filter: null,
      properties: opts.properties?.map((id) => ({ id })),
    },
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
    options:
      opts.own === false
        ? undefined
        : { leading: () => <i data-testid="own-leading" /> },
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <ListView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

const precedes = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

afterEach(cleanup);

describe("data-view list leading field", () => {
  it("renders the leading field's cell before the view's own leading node", () => {
    const { getAllByTestId, getByTestId, getByText } = renderList([
      { ...avatar, leading: true },
      name,
      note,
    ]);
    const cells = getAllByTestId("spec-cell");
    // Exactly once: in the leading slot, not also in the subtitle.
    expect(cells).toHaveLength(1);
    expect(cells[0]!.textContent).toBe("★");
    const own = getByTestId("own-leading");
    expect(precedes(cells[0]!, own)).toBe(true);
    // Both sit in the icon slot, ahead of the body's title.
    expect(precedes(own, getByText("alpha"))).toBe(true);
  });

  it("never becomes the title", () => {
    const { container, getByText } = renderList(
      [{ ...avatar, leading: true }, name, note],
      { own: false },
    );
    // The title is the next field; the subtitle holds the rest.
    expect(getByText("alpha").className).toContain("text-foreground");
    expect(container.textContent).toBe("★alpha · memo");
  });

  it("without a leading flag the field stays an ordinary body term", () => {
    const { getByTestId, container } = renderList([name, avatar, note]);
    // The icon slot holds only the view's own node; the cell is in the run.
    expect(precedes(getByTestId("own-leading"), getByTestId("spec-cell"))).toBe(
      true,
    );
    expect(container.textContent).toBe("alpha · ★ · memo");
  });

  it("with no leading field visible, markup matches a schema without one", () => {
    const html = renderList([name, note]).container.innerHTML;
    cleanup();
    const hidden = renderList([{ ...avatar, leading: true }, name, note], {
      properties: ["name", "note"],
    });
    expect(hidden.container.innerHTML).toBe(html);
  });

  it("disappears when hidden through properties", () => {
    const { queryByTestId, getByTestId } = renderList(
      [{ ...avatar, leading: true }, name, note],
      { properties: ["name", "note"] },
    );
    expect(queryByTestId("spec-cell")).toBeNull();
    expect(getByTestId("own-leading")).toBeTruthy();
  });
});
