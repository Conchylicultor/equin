import { describe, expect, test } from "bun:test";
import { describeSchema } from "@plugins/packages/plugins/zod-introspect/core";
import { conversationsById } from "./resources";

// The epoch handoff inherits `conversations.by-id:rows` across a backend restart only while
// its row schema is wholly describable (query-resource's point definition is
// none on an opaque part) — a hot read the open agent-manager tabs replay.
describe("conversations.by-id.v2:rows", () => {
  test("its row schema has no opaque part", () => {
    expect(describeSchema(conversationsById.rows.schema).opaque).toEqual([]);
  });
});
