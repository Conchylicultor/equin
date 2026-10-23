import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  defineItemActions,
  type CoverContent,
  type DataViewRenderProps,
  type FieldDef,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import type { ItemActionZone } from "@plugins/primitives/plugins/data-view/core";
import { ListView } from "../components/list-view";

/**
 * The list's leading thumbnail: a covered surface draws each row's cover in the
 * leading slot, and the primary action sits over it; an explicit leading visual
 * (a `FieldDef.leading` field, the view's own `leading`) takes the slot instead.
 */

type Row = { id: string; name: string; art: string; note: string };

const name: FieldDef<Row> = {
  id: "name",
  label: "Name",
  type: "plain",
  value: (r) => r.name,
  primary: true,
};
const art: FieldDef<Row> = {
  id: "art",
  label: "Art",
  type: "plain",
  value: (r) => r.art,
  cover: true,
};
const note: FieldDef<Row> = {
  id: "note",
  label: "Note",
  type: "plain",
  value: (r) => r.note,
};
const glyph: FieldDef<Row> = {
  id: "glyph",
  label: "Glyph",
  type: "plain",
  value: () => "★",
  leading: true,
};

const ROWS: Row[] = [
  { id: "1", name: "alpha", art: "https://img/a.png", note: "memo" },
  { id: "2", name: "beta", art: "", note: "" },
];

function action(id: string) {
  return function Action({ placement }: ItemActionProps<Row>): ReactNode {
    return <button data-testid={id} data-placement={placement} />;
  };
}

function renderList(
  fields: FieldDef<Row>[],
  opts: {
    options?: unknown;
    cover?: (row: Row) => CoverContent | null;
    actions?: { id: string; zone?: ItemActionZone }[];
  } = {},
) {
  const Actions = defineItemActions<Row>();
  const plugin = {
    id: "data-view-list-thumbnail-test",
    description: "list thumbnail fixture",
    contributions: (opts.actions ?? []).map((a) =>
      Actions({ ...a, component: action(a.id) }),
    ),
    slots: { actions: Actions },
  } as unknown as LoadedPlugin;
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    rows: ROWS,
    fields,
    rowKey: (r) => r.id,
    state: { sort: [], query: "", filter: null },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: () => {},
    // Ungrouped fixtures: the grouping clock is never consulted.
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    options: opts.options,
    cover: opts.cover,
    itemActions: opts.actions ? Actions : undefined,
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <ListView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

const rowEl = (container: HTMLElement, key: string) =>
  container.querySelector(`[data-row-key="${key}"]`)!;

afterEach(cleanup);

describe("data-view list thumbnail", () => {
  it("draws the cover field as a thumbnail, out of the body", () => {
    const { container } = renderList([name, art, note]);
    const img = rowEl(container, "1").querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://img/a.png");
    // The URL is the picture, never also a subtitle term.
    expect(rowEl(container, "1").textContent).toBe("alpha · memo");
    // A coverless row on a covered surface keeps a (blank) frame, no image.
    expect(rowEl(container, "2").querySelector("img")).toBeNull();
    expect(rowEl(container, "2").querySelector(".size-cover-thumb")).not.toBe(
      null,
    );
  });

  it("takes the surface's cover accessor over the cover field", () => {
    const { container } = renderList([name, note], {
      cover: (r) => ({ kind: "image", src: `https://acc/${r.id}.png` }),
    });
    expect(
      rowEl(container, "2").querySelector("img")?.getAttribute("src"),
    ).toBe("https://acc/2.png");
  });

  it("an explicit leading field takes the slot: no thumbnail", () => {
    const { container } = renderList([glyph, name, art, note]);
    expect(container.querySelector(".size-cover-thumb")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(rowEl(container, "1").textContent?.startsWith("★alpha")).toBe(true);
  });

  it("the view's own leading option takes the slot: no thumbnail", () => {
    const { container, getAllByTestId } = renderList([name, art, note], {
      options: { leading: () => <i data-testid="own" /> },
    });
    expect(getAllByTestId("own")).toHaveLength(2);
    expect(container.querySelector(".size-cover-thumb")).toBeNull();
  });

  it("the tree chrome never draws a thumbnail", () => {
    const { container } = renderList([name, art, note], {
      options: { rowChrome: "tree" },
    });
    expect(container.querySelector(".size-cover-thumb")).toBeNull();
  });

  it("puts the primary action over the thumbnail, hover-revealed", () => {
    const { getAllByTestId } = renderList([name, art, note], {
      actions: [{ id: "play", zone: "primary" }, { id: "del" }],
    });
    const plays = getAllByTestId("play");
    expect(plays).toHaveLength(2);
    for (const play of plays) {
      expect(play.getAttribute("data-placement")).toBe("primary");
      // A sibling of the row box (never nested in its control), in a cell the
      // size of the thumbnail.
      expect(play.closest("[data-row-key]")).toBeNull();
      expect(play.closest(".size-cover-thumb")).not.toBeNull();
      // Revealed by hover: hidden (and inert) at rest.
      const cluster = play.closest(".opacity-0");
      expect(cluster?.className).toContain("pointer-events-none");
    }
    // Other actions stay in the row's hover cluster.
    for (const del of getAllByTestId("del")) {
      expect(del.getAttribute("data-placement")).toBe("cluster");
      expect(del.closest("[data-row-key]")).not.toBeNull();
    }
  });

  it("without a thumbnail the primary action joins the hover cluster", () => {
    const { getAllByTestId } = renderList([name, note], {
      actions: [{ id: "play", zone: "primary" }],
    });
    for (const play of getAllByTestId("play")) {
      expect(play.getAttribute("data-placement")).toBe("cluster");
      expect(play.closest("[data-row-key]")).not.toBeNull();
    }
  });
});

describe("data-view list subtitle", () => {
  it("skips an empty value — no 'Empty', no dangling separator", () => {
    const { container } = renderList([name, note]);
    expect(rowEl(container, "1").textContent).toBe("alpha · memo");
    expect(rowEl(container, "2").textContent).toBe("beta");
  });
});
