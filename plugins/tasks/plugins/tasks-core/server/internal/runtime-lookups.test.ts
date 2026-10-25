import { describe, expect, test } from "bun:test";
import { runtimeOfConversationLookup } from "./runtime-lookups";

// The runtime lookup's route is what `conversations.context-usage` is reached
// by: matched on the conversation's own id, gated on exactly the columns the
// lookup reads — so another conversation's write, or this one's
// `waiting_for` / `last_viewed_at` / `working_on`, re-asks no agent.

describe("runtime lookup", () => {
  test("of a conversation: its own row, gated on id, runtime and status", () => {
    const read = runtimeOfConversationLookup.read<{ id: string }>((p) => p.id);
    expect(
      read.routes.map((r) => ({
        table: r.table,
        columns: [...r.columns].sort(),
        match: r.match,
      })),
    ).toEqual([
      {
        table: "conversations",
        columns: ["id", "runtime", "status"],
        match: ["id"],
      },
    ]);
  });
});
