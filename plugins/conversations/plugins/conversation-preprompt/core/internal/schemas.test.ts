import { describe, expect, test } from "bun:test";
import { describeSchema } from "@plugins/packages/plugins/zod-introspect/core";
import { conversationPrepromptRows } from "./schemas";

// The epoch handoff inherits `conversation-preprompts:rows` across a backend restart only while
// its row schema is wholly describable (query-resource's point definition is
// none on an opaque part) — a hot read the open agent-manager tabs replay.
describe("conversation-preprompts:rows", () => {
  test("its row schema has no opaque part", () => {
    expect(
      describeSchema(conversationPrepromptRows.rows.schema).opaque,
    ).toEqual([]);
  });
});
