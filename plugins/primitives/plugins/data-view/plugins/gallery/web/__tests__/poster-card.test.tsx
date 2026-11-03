import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
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
import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { Fields } from "@plugins/fields/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { GalleryView } from "../components/gallery-view";
import type { GalleryViewOptions } from "../internal/options";

/**
 * The poster card: the title and subtitle are written ON the cover (over the
 * scrim), the excerpt and the tokens under it — the excerpt only when the row
 * has one. And a chip token carries no type icon. Local fixture cells for
 * synthetic types (no `fields/*` import: that is a cycle).
 */
function PlainCell(props: TableCellProps) {
  return <span>{String(props.value ?? "")}</span>;
}
function ChipCell(props: TableCellProps) {
  return <span data-testid="chip">{String(props.value ?? "")}</span>;
}

/** Both synthetic types carry an icon: the token line draws it before a plain
 *  value, never before a chip. */
const plainIdentity = defineFieldIdentity<string>({
  type: defineFieldType<string>("plain"),
  kind: "label",
  icon: symbol("title"),
});
const chippyIdentity = defineFieldIdentity<string>({
  type: defineFieldType<string>("chippy"),
  kind: "label",
  icon: symbol("label"),
});

const plugin = {
  id: "data-view-gallery-poster-test",
  description: "gallery poster fixture",
  contributions: [
    DataViewSlots.Cell({ match: "plain", component: PlainCell }),
    DataViewSlots.Cell({ match: "chippy", component: ChipCell, chip: true }),
    Fields.Identity({ identity: plainIdentity }),
    Fields.Identity({ identity: chippyIdentity }),
  ],
  slots: { ...DataViewSlots, Identity: Fields.Identity },
} as unknown as LoadedPlugin;

type Row = {
  id: string;
  name: string;
  city: string;
  note: string;
  tag: string;
};

const FIELDS: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "plain",
    primary: true,
    value: (r) => r.name,
  },
  { id: "city", label: "City", type: "plain", value: (r) => r.city },
  { id: "note", label: "Note", type: "plain", value: (r) => r.note },
  { id: "tag", label: "Tag", type: "chippy", value: (r) => r.tag },
  { id: "rank", label: "Rank", type: "plain", value: (r) => r.city.length },
];

const ROWS: Row[] = [
  {
    id: "1",
    name: "Septime",
    city: "Paris",
    note: "Book 3 weeks ahead",
    tag: "Food",
  },
  { id: "2", name: "Rodin", city: "Paris", note: "", tag: "Museums" },
];

function renderGallery(card: GalleryViewOptions["card"]) {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    placement: {
      place: { city: "line2", note: "excerpt", tag: "trail", rank: "trail" },
    },
    rows: ROWS,
    fields: FIELDS,
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
    options: { card } satisfies GalleryViewOptions,
    cover: () => ({ kind: "node", node: <i data-testid="photo" /> }),
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <GalleryView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

const card = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLElement>(`[data-row-key="${key}"]`)!;

afterEach(cleanup);

describe("data-view gallery poster card", () => {
  it("writes the title and subtitle on the cover, the excerpt and tokens under it", () => {
    const { container } = renderGallery("poster");
    const first = card(container, "1");
    const cover = first.querySelector<HTMLElement>('[data-part="dv.cover"]')!;
    const caption = within(cover).getByText("Septime");
    expect(caption.closest('[data-part="dv.card-caption"]')).toBeTruthy();
    expect(within(cover).getByText("Paris")).toBeTruthy();
    expect(cover.querySelector('[data-part="dv.cover-scrim"]')).toBeTruthy();
    // Under the cover, not on it.
    const excerpt = first.querySelector('[data-part="dv.card-excerpt"]')!;
    expect(excerpt.textContent).toBe("Book 3 weeks ahead");
    expect(cover.contains(excerpt)).toBe(false);
    expect(within(first).getByTestId("chip").textContent).toBe("Food");
  });

  it("draws no excerpt for a row without one", () => {
    const { container } = renderGallery("poster");
    expect(
      card(container, "2").querySelector('[data-part="dv.card-excerpt"]'),
    ).toBeNull();
  });

  it("the cover card keeps its words under the cover and no scrim", () => {
    const { container } = renderGallery("cover");
    const first = card(container, "1");
    const cover = first.querySelector<HTMLElement>('[data-part="dv.cover"]')!;
    expect(within(cover).queryByText("Septime")).toBeNull();
    expect(cover.querySelector('[data-part="dv.cover-scrim"]')).toBeNull();
    expect(
      first.querySelector('[data-part="dv.card-excerpt"]')?.textContent,
    ).toBe("Book 3 weeks ahead");
  });

  it("puts no type icon before a chip token, and keeps it before others", () => {
    const { container } = renderGallery("cover");
    const tokens = [
      ...card(container, "1").querySelectorAll('[data-part="dv.card-token"]'),
    ];
    expect(tokens).toHaveLength(2);
    const [tag, rank] = tokens;
    expect(tag!.querySelector('[data-part="dv.card-token-icon"]')).toBeNull();
    expect(
      rank!.querySelector('[data-part="dv.card-token-icon"]'),
    ).toBeTruthy();
  });
});
