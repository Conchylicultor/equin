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
 * A field placed in `lead` (`placement.place`) renders in the row's leading
 * slot and nowhere in the body. The cell is a
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

// The avatar comes FIRST and nothing is `primary`, so were it not placed in
// `lead` the title promotion would take it.
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
  opts: { properties?: string[]; lead?: boolean } = {},
) {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    placement:
      opts.lead !== false && fields.some((f) => f.id === "avatar")
        ? { place: { avatar: "lead" } }
        : {},
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
    options: undefined,
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

describe("data-view list lead field", () => {
  it("renders the lead field's cell once, in the icon slot ahead of the title", () => {
    const { getAllByTestId, getByText } = renderList([avatar, name, note]);
    const cells = getAllByTestId("spec-cell");
    // Exactly once: in the lead slot, not also in the subtitle.
    expect(cells).toHaveLength(1);
    expect(cells[0]!.textContent).toBe("★");
    expect(precedes(cells[0]!, getByText("alpha"))).toBe(true);
  });

  it("never becomes the title", () => {
    const { container, getByText } = renderList([avatar, name, note]);
    // The title is the next field; the rest trail.
    expect(getByText("alpha").className).toContain("text-foreground");
    expect(container.textContent).toContain("★alpha");
    expect(container.textContent).toContain("memo");
  });

  it("without a pin the field is an ordinary trailing term, after the title", () => {
    const { getByTestId, getByText } = renderList([name, avatar, note], {
      lead: false,
    });
    expect(precedes(getByText("alpha"), getByTestId("spec-cell"))).toBe(true);
  });

  it("with no lead field visible, markup matches a schema without one", () => {
    const html = renderList([name, note]).container.innerHTML;
    cleanup();
    const hidden = renderList([avatar, name, note], {
      properties: ["name", "note"],
    });
    expect(hidden.container.innerHTML).toBe(html);
  });

  it("takes the leading slot from a cover field: no thumbnail", () => {
    const art: FieldDef<Row> = {
      id: "art",
      label: "Art",
      type: "plain",
      value: () => "https://img/a.png",
      cover: true,
    };
    const { container, getAllByTestId } = renderList([avatar, name, art]);
    expect(getAllByTestId("spec-cell")).toHaveLength(1);
    expect(container.querySelector(".size-cover-thumb")).toBeNull();
    // Not drawn as a thumbnail, the cover field stays an ordinary body term.
    expect(container.textContent).toContain("https://img/a.png");
  });

  it("disappears when hidden through properties", () => {
    const { queryByTestId } = renderList([avatar, name, note], {
      properties: ["name", "note"],
    });
    expect(queryByTestId("spec-cell")).toBeNull();
  });
});
