import { describe, expect, test } from "bun:test";
import { tableLayoutRequirements, type Route } from "./routing";

// The change-feed trigger layout, derived from the routes
// (research/2026-09-29-global-scoped-change-routing.md P3): what each table's
// changes must carry, and the column sets its routes read (what an UPDATE's
// `unchanged` comparison is resolved from).

const resolve = async () => [] as string[];

describe("tableLayoutRequirements", () => {
  test("carries every map column and every rows / match key; lists each route's column set", () => {
    const routes: Route[] = [
      // The base: an identity on the PK carries nothing (ids are the PK).
      {
        id: "base",
        table: "hosts",
        map: { kind: "identity" },
        columns: ["id", "n"],
      },
      // A reverse lookup on the same table reads other columns: its own set.
      {
        id: "self",
        table: "hosts",
        map: { kind: "reverse", column: "src", resolve },
        columns: ["src", "title"],
      },
      {
        id: "cc",
        table: "custom_values",
        map: { kind: "alias", column: "row_key" },
        columns: ["value", "row_key", "column_id", "data_view_id"],
        rows: { data_view_id: "s" },
        match: ["column_id"],
      },
      // A `full` route carries nothing, but its columns are still a read set.
      {
        id: "g",
        table: "groups_src",
        map: { kind: "full", reason: "aggregate" },
        columns: ["k"],
      },
    ];
    expect(tableLayoutRequirements(routes)).toEqual([
      {
        table: "custom_values",
        carry: ["column_id", "data_view_id", "row_key"],
        reads: [["column_id", "data_view_id", "row_key", "value"]],
      },
      { table: "groups_src", carry: [], reads: [["k"]] },
      {
        table: "hosts",
        carry: ["src"],
        // One set per route, each sorted — the trigger compares only the
        // sets that miss some column of the table.
        reads: [
          ["id", "n"],
          ["src", "title"],
        ],
      },
    ]);
  });

  test("A17: a reverse on the changed table's PK (no `column`) carries nothing — its values are `ids`", () => {
    const routes: Route[] = [
      {
        id: "src",
        table: "sources",
        map: { kind: "reverse", resolve },
        columns: ["id", "label"],
      },
    ];
    expect(tableLayoutRequirements(routes)).toEqual([
      { table: "sources", carry: [], reads: [["id", "label"]] },
    ]);
  });

  test("two routes reading the same columns list their set once", () => {
    const route = (id: string, columns: string[]): Route => ({
      id,
      table: "t",
      map: { kind: "identity" },
      columns,
    });
    expect(
      tableLayoutRequirements([route("a", ["y", "x"]), route("b", ["x", "y"])]),
    ).toEqual([{ table: "t", carry: [], reads: [["x", "y"]] }]);
  });

  test("the same routes in another order derive the same layout (a stable trigger signature)", () => {
    const a: Route = {
      id: "a",
      table: "t",
      map: { kind: "alias", column: "x" },
      columns: ["x", "y"],
    };
    const b: Route = {
      id: "b",
      table: "t",
      map: { kind: "identity", column: "z" },
      columns: ["z"],
    };
    expect(tableLayoutRequirements([a, b])).toEqual(
      tableLayoutRequirements([b, a]),
    );
  });
});
