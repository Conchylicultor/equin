import { describe, it, expect, afterEach } from "vitest";
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
import { Fields } from "@plugins/fields/web";
import { GalleryView } from "../components/gallery-view";
import type { GalleryViewOptions } from "../internal/options";

/**
 * `layout: "strip"`: every card in ONE sideways-scrolling row at the strip's
 * fixed width (a filmstrip), the selected card ringed, a card's activation
 * its row's — the same card the grid draws, only laid out in a row.
 */
const plugin = {
  id: "data-view-gallery-strip-test",
  description: "gallery strip fixture",
  contributions: [],
  slots: { ...DataViewSlots, Identity: Fields.Identity },
} as unknown as LoadedPlugin;

type Row = { id: string; name: string };

const name: FieldDef<Row> = {
  id: "name",
  label: "Name",
  type: "plain",
  value: (r) => r.name,
};

const ROWS: Row[] = [
  { id: "a", name: "Task list" },
  { id: "b", name: "Task detail" },
  { id: "c", name: "Empty state" },
];

function renderGallery(
  options: GalleryViewOptions | undefined,
  activated: string[] = [],
) {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    placement: {},
    rows: ROWS,
    fields: [name],
    rowKey: (r) => r.id,
    state: { sort: [], query: "", filter: null },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: () => {},
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    options,
    selectedRowId: "b",
    rowActivation: (r) => () => {
      activated.push(r.id);
    },
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <GalleryView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

afterEach(cleanup);

describe("data-view gallery strip layout", () => {
  it("lays every card in one fixed-width row inside a sideways scroller", () => {
    const { container } = renderGallery({ layout: "strip" });
    const cards = container.querySelectorAll('[data-part~="dv.card"]');
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.parentElement?.className).toContain("w-gallery-strip-card");
    }
    // One row, never the auto-fill grid.
    const row = cards[0]!.parentElement!.parentElement!;
    expect(row.className).toContain("gap-x-gallery-strip");
    expect(container.querySelector('[class*="gap-y-gallery"]')).toBeNull();
  });

  it("rings the selected card and activates a card's own row", () => {
    const activated: string[] = [];
    const { container } = renderGallery({ layout: "strip" }, activated);
    const selected = container.querySelector('[data-row-key="b"]')!;
    expect(
      selected.querySelector('[data-part~="dv.cover"]')!.className,
    ).toContain("ring-primary");
    fireEvent.click(container.querySelector('[data-row-key="c"]')!);
    expect(activated).toEqual(["c"]);
  });

  it("keeps the grid by default", () => {
    const { container } = renderGallery(undefined);
    expect(container.querySelector(".w-gallery-strip-card")).toBeNull();
    expect(container.querySelector('[class*="gap-y-gallery"]')).not.toBeNull();
  });
});
