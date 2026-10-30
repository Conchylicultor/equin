import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type {
  DataViewAttachConfig,
  DataViewRenderProps,
  FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { ListView } from "../components/list-view";

// `attach`: a row drawn beneath its parent's row — indented, behind a
// disclosure keyed apart from the row's own, never a manual-order drag source.
const plugin = {
  id: "data-view-list-attach-test",
  description: "list attach fixture",
  contributions: [],
} as unknown as LoadedPlugin;

type Row = { id: string; parent: string | null; rank: Rank };

const FIELDS: FieldDef<Row>[] = [
  { id: "id", label: "Id", type: "text", value: (r) => r.id, primary: true },
];

const [r0, r1, r2] = Rank.nBetween(null, null, 3);
const ROWS: Row[] = [
  { id: "sup", parent: null, rank: r0! },
  { id: "worker", parent: "sup", rank: r1! },
  { id: "solo", parent: null, rank: r2! },
];

const ATTACH: DataViewAttachConfig<Row> = {
  getKey: (r) => r.id,
  getParentKey: (r) => r.parent,
};

function renderList(over: Partial<DataViewRenderProps<Row>> = {}): {
  changes: { id: string; expanded: boolean }[][];
} {
  const changes: { id: string; expanded: boolean }[][] = [];
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    placement: {},
    rows: ROWS,
    fields: FIELDS,
    rowKey: (r) => r.id,
    state: { sort: [], query: "", filter: null },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: (c) => changes.push([...c]),
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    attach: ATTACH,
    options: undefined,
    ...over,
  };
  render(
    <PluginProvider plugins={[plugin]}>
      <ListView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
  return { changes };
}

const rowEl = (key: string) =>
  document.querySelector(`[data-row-key="${key}"]`);

afterEach(cleanup);

describe("data-view list: attached rows", () => {
  it("collapsed by default: the parent offers its attached row, which is not drawn", () => {
    renderList();
    expect(rowEl("sup")).not.toBeNull();
    expect(rowEl("solo")).not.toBeNull();
    expect(rowEl("worker")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show 1 attached" }),
    ).toBeTruthy();
  });

  it("open (defaultExpanded): the attached row is drawn beneath its parent, before the next top-level row", () => {
    renderList({ attach: { ...ATTACH, defaultExpanded: true } });
    const keys = [...document.querySelectorAll("[data-row-key]")].map((el) =>
      el.getAttribute("data-row-key"),
    );
    expect(keys).toEqual(["sup", "worker", "solo"]);
  });

  it("the disclosure writes its own expand key, never the row's", () => {
    const { changes } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 attached" }));
    expect(changes).toEqual([[{ id: "attach:sup", expanded: true }]]);
  });

  it("a selected attached row opens its parent", () => {
    renderList({ selectedRowId: "worker" });
    expect(rowEl("worker")).not.toBeNull();
  });

  it("under manual order, an attached row is no drag source", () => {
    renderList({
      attach: { ...ATTACH, defaultExpanded: true },
      manualOrder: { getRank: (r) => r.rank, onMove: () => {} },
    });
    // A sortable row is wrapped in its drag source — a second, outer
    // `[data-row-key]` box (`ManualOrderRow`).
    const boxes = (key: string) =>
      document.querySelectorAll(`[data-row-key="${key}"]`).length;
    expect(boxes("sup")).toBe(2);
    expect(boxes("worker")).toBe(1);
  });

  it("without attach every row is top-level", () => {
    renderList({ attach: undefined });
    const keys = [...document.querySelectorAll("[data-row-key]")].map((el) =>
      el.getAttribute("data-row-key"),
    );
    expect(keys).toEqual(["sup", "worker", "solo"]);
    expect(screen.queryByRole("button", { name: /attached/ })).toBeNull();
  });
});
