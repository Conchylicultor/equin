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
} from "@plugins/primitives/plugins/data-view/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { TableView } from "../components/table-view";

/**
 * Every nested table row carries `data-row-key` — the row's key in the
 * DataView, the marker the DataView measures the rows it has on screen by. An
 * alias (a second drawing of a row under a reference parent) carries none:
 * the real row already marks it. (The tree view's `row-key.test.tsx`, ported.)
 */

const plugin = {
  id: "data-view-table-nested-row-key-test",
  description: "nested table row-key fixture",
  contributions: [],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { key: string; name: string; parent: string | null };

const name: FieldDef<Row> = {
  id: "name",
  label: "Name",
  type: "plain",
  value: (r) => r.name,
};

const ROWS: Row[] = [
  { key: "k-root", name: "root", parent: null },
  { key: "k-child", name: "child", parent: "k-root" },
  { key: "k-other", name: "other", parent: null },
];

function renderTable() {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    rows: ROWS,
    fields: [name],
    rowKey: (r) => r.key,
    state: { sort: [], query: "", filter: null },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: () => {},
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    hierarchy: {
      getParentId: (r) => r.parent,
      getRank: () => Rank.from("a0"),
      // `child` also shows, as a reference, under `other`.
      getAliasParents: (r) => (r.key === "k-child" ? ["k-other"] : []),
    },
    options: { defaultExpanded: true },
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <TableView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

afterEach(cleanup);

describe("data-view nested table row keys", () => {
  it("stamps each drawn row with its DataView row key, once", () => {
    const { container, getAllByText } = renderTable();
    const keys = [...container.querySelectorAll("[data-row-key]")].map((el) =>
      el.getAttribute("data-row-key"),
    );
    expect(keys.sort()).toEqual(["k-child", "k-other", "k-root"]);
    // The alias is drawn too, without a key of its own.
    expect(getAllByText("child")).toHaveLength(2);
    expect(container.querySelectorAll("[data-tree-row]")).toHaveLength(4);
  });

  it("nests: each row states its level, the grid is a treegrid", () => {
    const { container } = renderTable();
    expect(container.querySelector("[role='treegrid']")).not.toBeNull();
    const level = (key: string) =>
      container
        .querySelector(`[data-row-key='${key}']`)!
        .getAttribute("aria-level");
    expect(level("k-root")).toBe("1");
    expect(level("k-child")).toBe("2");
    expect(level("k-other")).toBe("1");
  });
});
