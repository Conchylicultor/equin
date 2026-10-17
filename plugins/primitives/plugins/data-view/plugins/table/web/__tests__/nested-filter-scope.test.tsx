import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { clause } from "@plugins/network/plugins/live/plugins/filter/core";
import {
  DataViewSlots,
  type DataViewRenderProps,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  FilterGroup,
  FilterScope,
} from "@plugins/primitives/plugins/data-view/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { TableView } from "../components/table-view";

/**
 * `ViewState.filterScope` in the nested table (the tree view's
 * `filter-scope.test.tsx`, ported): `roots` tests only the roots and keeps
 * each kept root's WHOLE subtree, pulling in no ancestor. `rows` (the default)
 * keeps matches plus their ancestor chain.
 */

const plugin = {
  id: "data-view-table-nested-filter-scope-test",
  description: "nested table filter-scope fixture",
  contributions: [
    // A synthetic `tag` type with one text operator — no `fields/*` import
    // (that is a cycle).
    DataViewSlots.Filter({
      match: "tag",
      domain: "text",
      operators: [
        {
          id: "contains",
          label: "Contains",
          hasValue: true,
          lower: (op, { column }) =>
            typeof op === "string" && op !== ""
              ? clause(column, "contains", op)
              : undefined,
        },
      ],
    }),
  ],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; parent: string | null; tag: string };

// a (user) ─ a1 (agent) ─ a11 (user)
// b (agent) ─ b1 (user)
const ROWS: Row[] = [
  { id: "a", parent: null, tag: "user" },
  { id: "a1", parent: "a", tag: "agent" },
  { id: "a11", parent: "a1", tag: "user" },
  { id: "b", parent: null, tag: "agent" },
  { id: "b1", parent: "b", tag: "user" },
];

const fields: FieldDef<Row>[] = [
  {
    id: "label",
    label: "Label",
    type: "plain",
    primary: true,
    value: (r) => r.id,
  },
  { id: "tag", label: "Tag", type: "tag", value: (r) => r.tag },
];

const AGENT: FilterGroup = {
  kind: "group",
  id: "root",
  conjunction: "and",
  children: [
    {
      kind: "rule",
      id: "r",
      fieldId: "tag",
      operatorId: "contains",
      value: "agent",
    },
  ],
};

function renderedIds(filterScope: FilterScope | undefined): string[] {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    rows: ROWS,
    fields,
    rowKey: (r) => r.id,
    state: {
      sort: [],
      query: "",
      filter: AGENT,
      properties: [{ id: "label" }],
      filterScope,
    },
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
    },
    options: { defaultExpanded: true },
  };
  const { container } = render(
    <PluginProvider plugins={[plugin]}>
      <TableView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
  return [...container.querySelectorAll("[data-tree-id]")].map((el) =>
    el.getAttribute("data-tree-id")!,
  );
}

afterEach(cleanup);

describe("data-view nested table filterScope", () => {
  it("roots: a kept root keeps its whole subtree, and no ancestor is pulled in", () => {
    // `b` matches and keeps its user child; `a1` matches but its root `a`
    // does not, so nothing under `a` renders — not even `a1` itself.
    expect(renderedIds("roots")).toEqual(["b", "b1"]);
  });

  it("rows (default): matches plus their ancestor chain", () => {
    expect(renderedIds(undefined)).toEqual(["a", "a1", "b"]);
  });
});
