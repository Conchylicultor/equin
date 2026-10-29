import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { deleteBinding, putBinding } from "./endpoints";

const params = {
  conversationId: "c1",
  messageId: "m2",
  tag: "go",
  occurrenceIndex: "0",
};

function valueTarget(def: { effect: unknown }, body?: unknown) {
  const [t] = readLiveEffect(def.effect as never).resolve({
    params,
    body,
  }).targets;
  if (t?.kind !== "value") throw new Error("expected a value target");
  return t;
}

const existing = [
  { messageId: "m1", tag: "go", occurrenceIndex: 0, payload: 1 },
  { messageId: "m2", tag: "go", occurrenceIndex: 0, payload: "old" },
  { messageId: "m3", tag: "go", occurrenceIndex: 0, payload: 3 },
];

describe("binding effects", () => {
  test("put targets the conversation's tuple and replaces the binding in place", () => {
    const t = valueTarget(putBinding, { payload: "new" });
    expect(t.params).toEqual({ conversationId: "c1" });
    expect(t.apply(existing)).toEqual([
      existing[0],
      existing[1] && { ...existing[1], payload: "new" },
      existing[2],
    ]);
  });

  test("put adds an absent binding in the server's order", () => {
    const t = valueTarget(putBinding, { payload: "x" });
    const next = t.apply([existing[0], existing[2]]) as typeof existing;
    expect(next.map((b) => b.messageId)).toEqual(["m1", "m2", "m3"]);
  });

  test("delete drops just that binding", () => {
    const t = valueTarget(deleteBinding);
    expect(
      (t.apply(existing) as typeof existing).map((b) => b.messageId),
    ).toEqual(["m1", "m3"]);
  });
});
