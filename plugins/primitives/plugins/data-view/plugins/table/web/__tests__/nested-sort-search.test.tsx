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
  type SortRule,
} from "@plugins/primitives/plugins/data-view/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { TableView } from "../components/table-view";

/**
 * The nested table's sort and search keep the hierarchy: a sort orders each
 * sibling group (never children away from their parent) and suspends the
 * tree's drag; a search keeps every match's ancestor chain, forced open.
 */

const plugin = {
  id: "data-view-table-nested-sort-search-test",
  description: "nested table sort/search fixture",
  contributions: [],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; parent: string | null; name: string; rank: string };

// Rank order:            Name order:
//   zeta                   alpha
//     yak                    bee
//     bee                    deep-match
//       deep-match         zeta
//   alpha                    bee
//     cat                    yak
const ROWS: Row[] = [
  { id: "z", parent: null, name: "zeta", rank: "a0" },
  { id: "y", parent: "z", name: "yak", rank: "a0" },
  { id: "b", parent: "z", name: "bee", rank: "a1" },
  { id: "d", parent: "b", name: "deep-match", rank: "a0" },
  { id: "a", parent: null, name: "alpha", rank: "a1" },
  { id: "c", parent: "a", name: "cat", rank: "a0" },
];

const fields: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "plain",
    primary: true,
    value: (r) => r.name,
  },
];

function renderTable(
  state: { sort?: SortRule[]; query?: string },
  expanded: Record<string, boolean> | undefined,
) {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    rows: ROWS,
    fields,
    rowKey: (r) => r.id,
    state: { sort: state.sort ?? [], query: state.query ?? "", filter: null },
    setSort: () => {},
    sortHeader: { active: state.sort ?? [], sortable: new Set(["name"]) },
    setFilter: () => {},
    setExpanded: () => {},
    expanded,
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    hierarchy: {
      getParentId: (r) => r.parent,
      getRank: (r) => Rank.from(r.rank),
      onMove: () => {},
    },
    options: undefined,
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <TableView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

const ids = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-tree-id]")].map((el) =>
    el.getAttribute("data-tree-id")!,
  );
const draggable = (container: HTMLElement) =>
  container
    .querySelector("[data-tree-id='z']")!
    .hasAttribute("aria-roledescription");

const ALL_OPEN = { z: true, b: true, a: true };

afterEach(cleanup);

describe("data-view nested table: sort", () => {
  it("unsorted: the manual (rank) order, and rows drag", () => {
    const { container } = renderTable({}, ALL_OPEN);
    expect(ids(container)).toEqual(["z", "y", "b", "d", "a", "c"]);
    expect(draggable(container)).toBe(true);
  });

  it("sorts within each sibling group, never a child away from its parent", () => {
    const { container } = renderTable(
      { sort: [{ fieldId: "name", direction: "asc" }] },
      ALL_OPEN,
    );
    expect(ids(container)).toEqual(["a", "c", "z", "b", "d", "y"]);
  });

  it("descending reverses each sibling group", () => {
    const { container } = renderTable(
      { sort: [{ fieldId: "name", direction: "desc" }] },
      ALL_OPEN,
    );
    expect(ids(container)).toEqual(["z", "y", "b", "d", "a", "c"]);
  });

  it("a sort suspends the drag", () => {
    const { container } = renderTable(
      { sort: [{ fieldId: "name", direction: "asc" }] },
      ALL_OPEN,
    );
    expect(draggable(container)).toBe(false);
  });
});

describe("data-view nested table: search", () => {
  it("keeps every match's ancestors, forced open, and drops the rest", () => {
    // Everything collapsed: the search opens the path to its match.
    const { container } = renderTable({ query: "deep" }, undefined);
    expect(ids(container)).toEqual(["z", "b", "d"]);
  });

  it("a match keeps its own children out unless they match", () => {
    const { container } = renderTable({ query: "alp" }, ALL_OPEN);
    expect(ids(container)).toEqual(["a"]);
  });
});
