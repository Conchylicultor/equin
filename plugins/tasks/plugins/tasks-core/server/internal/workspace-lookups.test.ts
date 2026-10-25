import { describe, expect, test } from "bun:test";
import {
  workspaceOfAttemptLookup,
  workspaceOfConversationLookup,
} from "./workspace-lookups";

// The two workspace lookups' routes are what a value reading through them is
// reached by: each gate must hold exactly the columns the lookup reads, so a
// conversation's turn (`status`, `waiting_for`, `last_viewed_at`, …) or an
// attempt's `task_id` move reaches no reader.

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

describe("workspace lookups", () => {
  test("of a conversation: the conversation's key and its attempt's, the attempt's checkout columns", () => {
    expect(
      gates(workspaceOfConversationLookup.read<{ id: string }>((p) => p.id)),
    ).toEqual([
      { table: "conversations", columns: ["attempt_id", "id"], match: ["id"] },
      {
        table: "attempts",
        columns: ["id", "workspace", "worktree_path"],
        match: undefined,
      },
    ]);
  });

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
