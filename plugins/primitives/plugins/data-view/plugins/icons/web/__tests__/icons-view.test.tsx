import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
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
import { useAvatarPresentation } from "@plugins/primitives/plugins/avatar/web/testing";
import { IconsView } from "../components/icons-view";

/**
 * The icons view draws one tile per row: the leading field inside a tile
 * presentation (or a letter tile when the schema has none) and the primary
 * field as the name. The cell is a local fixture for a synthetic type, and it
 * reports the ambient avatar presentation so the test can see the tile scope.
 */
function SpecCell(props: TableCellProps) {
  const presentation = useAvatarPresentation();
  return (
    <span data-testid="spec-cell" data-presentation={presentation}>
      {String(props.data)}
    </span>
  );
}

const plugin = {
  id: "data-view-icons-test",
  description: "icons view fixture",
  contributions: [DataViewSlots.Cell({ match: "spec", component: SpecCell })],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; glyph: string };

const avatar: FieldDef<Row> = {
  id: "avatar",
  label: "Avatar",
  type: "spec",
  data: (r) => r.glyph,
  leading: true,
};
const name: FieldDef<Row> = {
  id: "name",
  label: "Name",
  type: "text",
  value: (r) => r.name,
  primary: true,
};

const ROWS: Row[] = [
  { id: "a", name: "alpha", glyph: "★" },
  { id: "b", name: "beta", glyph: "◆" },
];

function renderIcons(
  fields: FieldDef<Row>[],
  over: Partial<DataViewRenderProps<Row>> = {},
) {
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
    // Ungrouped fixtures: the clock is never consulted.
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    options: undefined,
    ...over,
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <IconsView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

afterEach(cleanup);

describe("data-view icons view", () => {
  it("renders one tile per row: the leading cell in tile presentation, the name below", () => {
    const { getAllByTestId, getByText } = renderIcons([avatar, name]);
    const cells = getAllByTestId("spec-cell");
    expect(cells.map((c) => c.textContent)).toEqual(["★", "◆"]);
    for (const cell of cells)
      expect(cell.getAttribute("data-presentation")).toBe("tile");
    // The leading field is never the name.
    expect(getByText("alpha")).toBeTruthy();
    expect(getByText("beta")).toBeTruthy();
  });

  it("activates the row on click and Enter, and is a button only when it activates", () => {
    const opened: string[] = [];
    const { getByText } = renderIcons([avatar, name], {
      rowActivation: (r) =>
        r.id === "a"
          ? () => {
              opened.push(r.id);
            }
          : undefined,
    });
    const alpha = getByText("alpha").closest("[data-row-key]")!;
    const beta = getByText("beta").closest("[data-row-key]")!;
    expect(alpha.getAttribute("role")).toBe("button");
    expect(alpha.getAttribute("tabindex")).toBe("0");
    expect(beta.getAttribute("role")).toBeNull();
    expect(beta.getAttribute("tabindex")).toBeNull();

    fireEvent.click(alpha);
    fireEvent.keyDown(alpha, { key: "Enter" });
    fireEvent.click(beta);
    expect(opened).toEqual(["a", "a"]);
  });

  it("is one tab stop: arrows, Home and End move focus between the tiles", () => {
    const rows: Row[] = [...ROWS, { id: "c", name: "gamma", glyph: "●" }];
    const { container } = renderIcons([avatar, name], {
      rows,
      rowActivation: () => () => {},
    });
    const tiles = Array.from(
      container.querySelectorAll<HTMLElement>("[data-row-key]"),
    );
    const stops = () => tiles.map((t) => t.getAttribute("tabindex"));
    expect(stops()).toEqual(["0", "-1", "-1"]);

    tiles[0]!.focus();
    fireEvent.keyDown(tiles[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tiles[1]);
    // The tab stop follows focus, so Tab back in lands where the user was.
    expect(stops()).toEqual(["-1", "0", "-1"]);
    fireEvent.keyDown(tiles[1]!, { key: "End" });
    expect(document.activeElement).toBe(tiles[2]);
    fireEvent.keyDown(tiles[2]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tiles[2]);
    fireEvent.keyDown(tiles[2]!, { key: "Home" });
    expect(document.activeElement).toBe(tiles[0]);
    fireEvent.keyDown(tiles[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tiles[0]);
  });

  it("marks the selected row as current, and makes it the tab stop", () => {
    const { container } = renderIcons([avatar, name], {
      selectedRowId: "b",
      rowActivation: () => () => {},
    });
    const [a, b] = Array.from(
      container.querySelectorAll<HTMLElement>("[data-row-key]"),
    );
    expect(a!.getAttribute("aria-current")).toBeNull();
    expect(b!.getAttribute("aria-current")).toBe("true");
    expect(b!.getAttribute("tabindex")).toBe("0");
    expect(a!.getAttribute("tabindex")).toBe("-1");
  });

  it("draws the compact geometry under density=compact", () => {
    const { container } = renderIcons([avatar, name], { density: "compact" });
    const html = container.innerHTML;
    expect(html).toContain("[--icons-cell:72px]");
    expect(html).not.toContain("[--icons-cell:116px]");
  });

  it("draws a letter tile from the name when the schema has no leading field", () => {
    const { container, queryAllByTestId } = renderIcons([name]);
    expect(queryAllByTestId("spec-cell")).toHaveLength(0);
    const tiles = container.querySelectorAll("[data-row-key]");
    expect(tiles).toHaveLength(2);
    // The fallback letter, uppercased by the avatar, ahead of the name.
    expect(tiles[0]!.textContent).toBe("Aalpha");
    expect(tiles[1]!.textContent).toBe("Bbeta");
  });

  it("renders the empty state when nothing matches", () => {
    const onClick = vi.fn();
    const { getByText } = renderIcons([avatar, name], {
      rows: [],
      emptyState: <button onClick={onClick}>No app matches.</button>,
    });
    fireEvent.click(getByText("No app matches."));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
