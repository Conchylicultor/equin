import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { upsertNote, deleteNote } from "./endpoints";

function only(
  endpoint: { effect: Parameters<typeof readLiveEffect>[0] },
  body: unknown,
) {
  const [t, ...rest] = readLiveEffect(endpoint.effect).resolve({
    params: { conversationId: "conversationId-1" },
    body,
  }).targets;
  if (t === undefined || t.kind !== "row" || rest.length > 0) {
    throw new Error("expected exactly one row target");
  }
  return t;
}

describe("upsertNote effect", () => {
  test("upserts the row, compared on the chosen value", () => {
    const t = only(upsertNote, { notes: "hello" });
    expect(t.subject).toBe("collection:conversation-notes");
    expect(t.id).toBe("conversationId-1");
    expect(t.enters).toBe(true);
    expect(t.set).toEqual({ notes: "hello" });
    expect(t.apply(undefined)).toMatchObject({
      conversationId: "conversationId-1",
      notes: "hello",
    });
  });

  test("replaces the value of a held row and keeps its other fields", () => {
    const t = only(upsertNote, { notes: "hello" });
    const held = {
      conversationId: "conversationId-1",
      notes: "old",
      updatedAt: new Date("2026-01-01"),
    };
    expect(t.apply(held)).toEqual({ ...held, notes: "hello" });
  });
});

describe("deleteNote effect", () => {
  test("removes the row", () => {
    const t = only(deleteNote, undefined);
    expect(t.subject).toBe("collection:conversation-notes");
    expect(t.removes).toBe(true);
    expect(t.apply({ conversationId: "conversationId-1" })).toBeUndefined();
  });
});
