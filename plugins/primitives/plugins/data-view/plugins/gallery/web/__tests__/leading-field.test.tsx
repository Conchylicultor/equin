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
import { GalleryView } from "../components/gallery-view";

/**
 * A field declaring `leading: true` is the row's avatar: on a card with no
 * cover it fills the cover frame; it is never the title nor a text line. Local
 * fixture cell for a synthetic type (no `fields/*` import: that is a cycle).
 */
function SpecCell(props: TableCellProps) {
  return <span data-testid="spec-cell">{String(props.data)}</span>;
}

const plugin = {
  id: "data-view-gallery-leading-field-test",
  description: "gallery leading-field fixture",
  contributions: [DataViewSlots.Cell({ match: "spec", component: SpecCell })],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; glyph: string; note: string };

// The avatar comes FIRST and nothing is `primary`/`text`, so without the
// leading exclusion `pickPrimaryField`'s `fields[0]` fallback would title the
// card with it.
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

function renderGallery(
  fields: FieldDef<Row>[],
  opts: { properties?: string[]; cover?: boolean } = {},
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
    options: undefined,
    cover: opts.cover
      ? () => ({ kind: "node", node: <i data-testid="own-cover" /> })
      : undefined,
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <GalleryView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

afterEach(cleanup);

describe("data-view gallery leading field", () => {
  it("fills the cover frame of a card with no cover, once", () => {
    const { getAllByTestId, getByText } = renderGallery([
      { ...avatar, leading: true },
      name,
      note,
    ]);
    const cells = getAllByTestId("spec-cell");
    // Exactly once: in the frame, not also as a text line.
    expect(cells).toHaveLength(1);
    expect(
      cells[0]!.compareDocumentPosition(getByText("alpha")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("never becomes the title", () => {
    const { getByText } = renderGallery([
      { ...avatar, leading: true },
      name,
      note,
    ]);
    // The title line is the next field; memo is a line below it.
    const title = getByText("alpha");
    expect(
      title.compareDocumentPosition(getByText("memo")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(title.textContent).toBe("alpha");
  });

  it("a row's own cover wins over the leading field", () => {
    const { queryByTestId, getByTestId } = renderGallery(
      [{ ...avatar, leading: true }, name, note],
      { cover: true },
    );
    expect(getByTestId("own-cover")).toBeTruthy();
    expect(queryByTestId("spec-cell")).toBeNull();
  });

  it("without a leading flag the field stays an ordinary line", () => {
    const { getByTestId, getByText } = renderGallery([name, avatar, note]);
    const cell = getByTestId("spec-cell");
    expect(
      getByText("alpha").compareDocumentPosition(cell) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("disappears when hidden through properties", () => {
    const { queryByTestId, getByText } = renderGallery(
      [{ ...avatar, leading: true }, name, note],
      { properties: ["name", "note"] },
    );
    expect(queryByTestId("spec-cell")).toBeNull();
    expect(getByText("alpha")).toBeTruthy();
  });
});
