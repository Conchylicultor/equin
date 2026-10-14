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
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { TableView } from "../components/table-view";

/**
 * Nested, the table HAS a leading slot — the tree head's icon slot — so a
 * field declaring `leading: true` renders there, ahead of the view's own
 * `leadingIcon` option, and is no column. (The tree view's
 * `leading-field.test.tsx`, ported; flat, it stays an ordinary column — see
 * `leading-field.test.tsx`.) Local fixture cell for a synthetic type (no
 * `fields/*` import: that is a cycle).
 */
function SpecCell(props: TableCellProps) {
  return <span data-testid="spec-cell">{String(props.data)}</span>;
}

const plugin = {
  id: "data-view-table-nested-leading-field-test",
  description: "nested table leading-field fixture",
  contributions: [DataViewSlots.Cell({ match: "spec", component: SpecCell })],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; glyph: string; note: string };

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

function renderTable(
  fields: FieldDef<Row>[],
  opts: { visibleFields?: string[]; own?: boolean } = {},
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
      visibleFields: opts.visibleFields,
    },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: () => {},
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    hierarchy: {
      getParentId: () => null,
      getRank: () => Rank.from("a0"),
    },
    options:
      opts.own === false
        ? undefined
        : { leadingIcon: () => <i data-testid="own-leading" /> },
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <TableView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

const precedes = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

afterEach(cleanup);

describe("data-view nested table leading field", () => {
  it("renders the leading field's cell before the view's own leadingIcon", () => {
    const { getAllByTestId, getByTestId, getByText, queryByText } = renderTable(
      [{ ...avatar, leading: true }, name, note],
    );
    const cells = getAllByTestId("spec-cell");
    // Exactly once: in the icon slot, not also as a column.
    expect(cells).toHaveLength(1);
    expect(queryByText("Avatar")).toBeNull();
    const own = getByTestId("own-leading");
    expect(precedes(cells[0]!, own)).toBe(true);
    expect(precedes(own, getByText("alpha"))).toBe(true);
  });

  it("never becomes the label column", () => {
    const { getByText } = renderTable(
      [{ ...avatar, leading: true }, name, note],
      { own: false },
    );
    // The first column is the name; the note is the next one.
    expect(precedes(getByText("Name"), getByText("Note"))).toBe(true);
    expect(precedes(getByText("alpha"), getByText("memo"))).toBe(true);
  });

  it("without a leading flag the field stays an ordinary column", () => {
    const { getByTestId, getByText } = renderTable([name, avatar, note]);
    const cell = getByTestId("spec-cell");
    expect(getByText("Avatar")).toBeTruthy();
    expect(precedes(getByTestId("own-leading"), cell)).toBe(true);
    expect(precedes(getByText("alpha"), cell)).toBe(true);
  });

  it("with no leading field visible, markup matches a schema without one", () => {
    // dnd-kit numbers its accessibility regions per mount; that counter is the
    // only difference two mounts of identical tables may have.
    const markup = (el: HTMLElement) =>
      el.innerHTML.replace(/(DndDescribedBy|DndLiveRegion)-\d+/g, "$1");
    const html = markup(renderTable([name, note]).container);
    cleanup();
    const hidden = renderTable([{ ...avatar, leading: true }, name, note], {
      visibleFields: ["name", "note"],
    });
    expect(markup(hidden.container)).toBe(html);
  });

  it("disappears when hidden through visibleFields", () => {
    const { queryByTestId, getByTestId } = renderTable(
      [{ ...avatar, leading: true }, name, note],
      { visibleFields: ["name", "note"] },
    );
    expect(queryByTestId("spec-cell")).toBeNull();
    expect(getByTestId("own-leading")).toBeTruthy();
  });
});
