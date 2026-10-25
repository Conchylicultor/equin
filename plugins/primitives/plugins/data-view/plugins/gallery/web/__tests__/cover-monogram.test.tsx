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
 * A card with no cover and no leading field is never a blank frame: its frame
 * holds a monogram of the title (the first letter on the `Avatar` tile, tinted
 * by the title), which `coverMonogram: hide` drops. A cover or a leading field
 * wins over it.
 */
function SpecCell(props: TableCellProps) {
  return <span data-testid="spec-cell">{String(props.data)}</span>;
}

const plugin = {
  id: "data-view-gallery-cover-monogram-test",
  description: "gallery cover-monogram fixture",
  contributions: [DataViewSlots.Cell({ match: "spec", component: SpecCell })],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; glyph: string };

const name: FieldDef<Row> = {
  id: "name",
  label: "Name",
  type: "plain",
  value: (r) => r.name,
};
const avatar: FieldDef<Row> = {
  id: "avatar",
  label: "Avatar",
  type: "spec",
  data: (r) => r.glyph,
  leading: true,
};

function renderGallery(
  fields: FieldDef<Row>[],
  opts: { cover?: boolean; rowName?: string } = {},
) {
  const row: Row = {
    id: "1",
    name: opts.rowName ?? "zephyr notes",
    glyph: "★",
  };
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    rows: [row],
    fields,
    rowKey: (r) => r.id,
    state: { sort: [], query: "", filter: null },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: () => {},
    // Ungrouped: the clock is never consulted.
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

describe("data-view gallery cover monogram", () => {
  it("draws the title's first letter in a coverless, leading-less frame", () => {
    const { container } = renderGallery([name]);
    const frame = container.querySelector('[data-part~="dv.cover"]')!;
    const monogram = frame.querySelector("[data-cover-monogram]")!;
    expect(monogram).not.toBeNull();
    expect(monogram.textContent).toBe("Z");
    // Tinted by the title (an auto-coloured avatar), hidden by the token.
    expect(monogram.querySelector('[class*="bg-categorical-"]')).not.toBeNull();
    expect(monogram.className).toContain(
      "[@container_style(--cover-monogram:hide)]:hidden",
    );
  });

  it("gives way to the row's own cover", () => {
    const { container, getByTestId } = renderGallery([name], { cover: true });
    expect(getByTestId("own-cover")).toBeTruthy();
    expect(container.querySelector("[data-cover-monogram]")).toBeNull();
  });

  it("gives way to the leading field", () => {
    const { container, getByTestId } = renderGallery([avatar, name]);
    expect(getByTestId("spec-cell")).toBeTruthy();
    expect(container.querySelector("[data-cover-monogram]")).toBeNull();
  });

  it("leaves the frame blank when the title is blank", () => {
    const { container } = renderGallery([name], { rowName: "  " });
    expect(container.querySelector('[data-part~="dv.cover"]')).not.toBeNull();
    expect(container.querySelector("[data-cover-monogram]")).toBeNull();
  });
});
