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
import { TreeView } from "../components/tree-view";

/**
 * A field declaring `leading: true` renders in the tree row's icon slot — ahead
 * of the view's own `leadingIcon` option — and is out of the label pick and the
 * secondary chips. Local fixture cell for a synthetic type (no `fields/*`
 * import: that is a cycle).
 */
function SpecCell(props: TableCellProps) {
  return <span data-testid="spec-cell">{String(props.data)}</span>;
}

const plugin = {
  id: "data-view-tree-leading-field-test",
  description: "tree leading-field fixture",
  contributions: [DataViewSlots.Cell({ match: "spec", component: SpecCell })],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; glyph: string; note: string };

// The avatar comes FIRST and nothing is `primary`/`text`, so without the
// leading exclusion `pickPrimaryField`'s `fields[0]` fallback would label the
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

function renderTree(
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
    // Grouping inputs. These fixtures render UNGROUPED, so the clock is never
    // consulted — a pinned zero states that rather than borrowing the real one.
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
      <TreeView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

const precedes = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

afterEach(cleanup);

describe("data-view tree leading field", () => {
  it("renders the leading field's cell before the view's own leadingIcon", () => {
    const { getAllByTestId, getByTestId, getByText } = renderTree([
      { ...avatar, leading: true },
      name,
      note,
    ]);
    const cells = getAllByTestId("spec-cell");
    // Exactly once: in the icon slot, not also as a secondary chip.
    expect(cells).toHaveLength(1);
    const own = getByTestId("own-leading");
    expect(precedes(cells[0]!, own)).toBe(true);
    expect(precedes(own, getByText("alpha"))).toBe(true);
  });

  it("never becomes the row label", () => {
    const { getByText } = renderTree(
      [{ ...avatar, leading: true }, name, note],
      { own: false },
    );
    // The label is the truncating flexible span; memo is a secondary chip after it.
    expect(getByText("alpha").className).toContain("truncate");
    expect(precedes(getByText("alpha"), getByText("memo"))).toBe(true);
  });

  it("without a leading flag the field stays an ordinary secondary chip", () => {
    const { getByTestId, getByText } = renderTree([name, avatar, note]);
    const cell = getByTestId("spec-cell");
    expect(precedes(getByTestId("own-leading"), cell)).toBe(true);
    expect(precedes(getByText("alpha"), cell)).toBe(true);
  });

  it("with no leading field visible, markup matches a schema without one", () => {
    // dnd-kit numbers its accessibility regions per mount; that counter is the
    // only difference two mounts of identical trees may have.
    const markup = (el: HTMLElement) =>
      el.innerHTML
        .replace(/(DndDescribedBy|DndLiveRegion)-\d+/g, "$1")
        // The fold host's per-instance id (`useId`).
        .replace(/data-row-fold-host="[^"]*"/g, "data-row-fold-host");
    const html = markup(renderTree([name, note]).container);
    cleanup();
    const hidden = renderTree([{ ...avatar, leading: true }, name, note], {
      visibleFields: ["name", "note"],
    });
    expect(markup(hidden.container)).toBe(html);
  });

  it("disappears when hidden through visibleFields", () => {
    const { queryByTestId, getByTestId } = renderTree(
      [{ ...avatar, leading: true }, name, note],
      { visibleFields: ["name", "note"] },
    );
    expect(queryByTestId("spec-cell")).toBeNull();
    expect(getByTestId("own-leading")).toBeTruthy();
  });
});
