import { describe, expect, test } from "bun:test";
import { workspaceOfAttemptLookup } from "./workspace-lookups";

// The workspace lookup's routes are what a value reading through it is reached
// by: its gate must hold exactly the columns the lookup reads, so an attempt's
// `task_id` move reaches no reader.

const gates = (read: {
  routes: readonly {
    table: string;
    columns: readonly string[];
    match?: readonly string[];
  }[];
}) =>
  read.routes.map((r) => ({
    table: r.table,
    columns: [...r.columns].sort(),
    match: r.match,
  }));

describe("workspace lookup", () => {
  test("of an attempt: the attempt's checkout columns, matched on its id", () => {
    expect(
      gates(workspaceOfAttemptLookup.read<{ id: string }>((p) => p.id)),
    ).toEqual([
      {
        table: "attempts",
        columns: ["id", "workspace", "worktree_path"],
        match: ["id"],
      },
    ]);
  });
});
