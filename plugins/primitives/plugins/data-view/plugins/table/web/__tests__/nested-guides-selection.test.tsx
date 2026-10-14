import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  DataViewSlots,
  type DataViewRenderProps,
  type FieldDef,
  type HierarchyConfig,
} from "@plugins/primitives/plugins/data-view/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { TableView } from "../components/table-view";
import type { TableViewOptions } from "../../core";

/**
 * Two opt-in looks of the nested table (the tree view's
 * `guides-selection.test.tsx`, ported): indent guides in the first cell (one
 * hairline box per row, covering its ancestor levels) and the outline
 * presentation's selected row (the tree row's tokens) — both of which leave a
 * table that does not ask unchanged.
 */

const plugin = {
  id: "data-view-table-nested-guides-selection-test",
  description: "nested table guides/selection fixture",
  contributions: [],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; parent: string | null; name: string; size: string };

const ROWS: Row[] = [
  { id: "src", parent: null, name: "src", size: "—" },
  { id: "lib", parent: "src", name: "lib", size: "—" },
  { id: "deep", parent: "lib", name: "deep.ts", size: "1 KB" },
  { id: "readme", parent: null, name: "README.md", size: "2 KB" },
];

const fields: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "plain",
    primary: true,
    value: (r) => r.name,
  },
  {
    id: "size",
    label: "Size",
    type: "plain",
    width: "80px",
    value: (r) => r.size,
  },
];

function renderTable(
  options: TableViewOptions<Row>,
  over: Partial<DataViewRenderProps<Row>> & {
    lazy?: HierarchyConfig<Row>["lazyChildren"];
  } = {},
) {
  const { lazy, ...rest } = over;
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
    expanded: { src: true, lib: true },
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    hierarchy: {
      getParentId: (r) => r.parent,
      getRank: (r) => Rank.from(r.id === "readme" ? "a1" : "a0"),
      lazyChildren: lazy,
    },
    options,
    ...rest,
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <TableView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

const rowOf = (getByText: (t: string) => HTMLElement, label: string) =>
  getByText(label).closest<HTMLElement>("[data-tree-row]")!;

// A selected row reveals itself on mount; jsdom has no scrolling.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

describe("data-view nested table: indent guides", () => {
  it("draws none unless asked", () => {
    const { container } = renderTable({});
    expect(container.querySelector("[data-tree-guides]")).toBeNull();
  });

  it("draws one box per nested row, covering its ancestor levels", () => {
    const { getByText } = renderTable({ guides: true });
    const guidesOf = (label: string) =>
      rowOf(getByText, label)
        .querySelector("[data-tree-guides]")
        ?.getAttribute("data-tree-guides") ?? null;
    expect(guidesOf("src")).toBeNull();
    expect(guidesOf("README.md")).toBeNull();
    expect(guidesOf("lib")).toBe("1");
    expect(guidesOf("deep.ts")).toBe("2");
  });

  it("sits in the first cell's indent, as wide as the levels", () => {
    const { getByText } = renderTable({ guides: true });
    const box = rowOf(getByText, "deep.ts").querySelector<HTMLElement>(
      "[data-tree-guides]",
    )!;
    expect(box.getAttribute("aria-hidden")).toBe("true");
    expect(box.style.width).toBe("calc(2 * var(--tree-indent))");
    expect(box.style.backgroundSize).toContain("var(--tree-indent)");
    // In the first cell's head, ahead of the label — never in another column.
    const size = getByText("1 KB");
    expect(
      box.compareDocumentPosition(size) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      box.compareDocumentPosition(getByText("deep.ts")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("gives an open folder's placeholder row the guides its siblings have", () => {
    const { container } = renderTable(
      { guides: true },
      {
        rows: [ROWS[0]!, ROWS[3]!],
        expanded: { src: true },
        lazy: {
          hasChildren: (r) => r.id === "src",
          state: () => ({ kind: "loaded" }),
          load: () => {},
        },
      },
    );
    const placeholder = container.querySelector(
      "[data-tree-placeholder='empty']",
    )!;
    expect(
      placeholder
        .querySelector("[data-tree-guides]")
        ?.getAttribute("data-tree-guides"),
    ).toBe("1");
  });
});

describe("data-view nested table: presentation", () => {
  it("outline: the selected row wears the tree row's tokens, and no header", () => {
    const { getByText, queryByText } = renderTable(
      { presentation: "outline" },
      { selectedRowId: "deep" },
    );
    const selected = rowOf(getByText, "deep.ts");
    expect(selected.className).toContain("text-selected-foreground");
    expect(selected.className).toContain(
      "[--row-meta:var(--selected-meta-foreground)]",
    );
    expect(selected.className).not.toContain("border-b");

    const other = rowOf(getByText, "README.md");
    expect(other.className).not.toContain("text-selected-foreground");
    expect(other.className).not.toContain("--row-meta");
    expect(other.className).toContain("hover:bg-accent");

    expect(queryByText("Size")).toBeNull();
  });

  it("grid (default): the column header and the table's own rows", () => {
    const { getByText } = renderTable({}, { selectedRowId: "deep" });
    expect(getByText("Size")).toBeTruthy();
    const selected = rowOf(getByText, "deep.ts");
    // The grid row tints through `--dt-row-tint`, which its pinned first
    // cell paints too.
    expect(selected.className).toContain("[--dt-row-tint:var(--accent)]");
    expect(selected.className).not.toContain("text-selected-foreground");
    expect(rowOf(getByText, "README.md").className).toContain("border-b");
  });
});
