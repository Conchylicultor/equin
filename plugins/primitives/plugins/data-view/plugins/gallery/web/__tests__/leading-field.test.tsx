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
 * A field declaring `leading: true` renders in the card's leading block — ahead
 * of the view's own `leading` option — and is out of the title and the property
 * rows. The cover stays media. Local fixture cell for a synthetic type (no
 * `fields/*` import: that is a cycle).
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
      <GalleryView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

const precedes = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

afterEach(cleanup);

describe("data-view gallery leading field", () => {
  it("renders the leading field's cell before the view's own leading node", () => {
    const { getAllByTestId, getByTestId, getByText } = renderGallery([
      { ...avatar, leading: true },
      name,
      note,
    ]);
    const cells = getAllByTestId("spec-cell");
    // Exactly once: in the leading block, not also as a property row.
    expect(cells).toHaveLength(1);
    const own = getByTestId("own-leading");
    expect(precedes(cells[0]!, own)).toBe(true);
    expect(precedes(own, getByText("alpha"))).toBe(true);
  });

  it("never becomes the title", () => {
    const { getByText } = renderGallery(
      [{ ...avatar, leading: true }, name, note],
      { own: false },
    );
    // The title is the next field (the semibold card title), memo a property row.
    expect(getByText("alpha").className).toContain("font-semibold");
    expect(getByText("memo").className).toContain("text-muted-foreground");
  });

  it("without a leading flag the field stays an ordinary property row", () => {
    const { getByTestId } = renderGallery([name, avatar, note]);
    const cell = getByTestId("spec-cell");
    expect(precedes(getByTestId("own-leading"), cell)).toBe(true);
    expect(cell.parentElement!.className).toContain("text-muted-foreground");
  });

  it("with no leading field and no option, the card has no leading block", () => {
    const withLeading = renderGallery([name, note], { own: false });
    const html = withLeading.container.innerHTML;
    cleanup();
    // The same schema with a hidden leading field renders byte-identical markup.
    const hidden = renderGallery([{ ...avatar, leading: true }, name, note], {
      own: false,
      properties: ["name", "note"],
    });
    expect(hidden.container.innerHTML).toBe(html);
  });

  it("disappears when hidden through properties", () => {
    const { queryByTestId, getByTestId } = renderGallery(
      [{ ...avatar, leading: true }, name, note],
      { properties: ["name", "note"] },
    );
    expect(queryByTestId("spec-cell")).toBeNull();
    expect(getByTestId("own-leading")).toBeTruthy();
  });
});
