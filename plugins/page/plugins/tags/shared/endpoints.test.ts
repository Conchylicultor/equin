import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { deletePageTag, putPageTags } from "./endpoints";

function resolve(
  def: { effect: Parameters<typeof readLiveEffect>[0] },
  params: Record<string, string>,
  body?: unknown,
) {
  return readLiveEffect(def.effect).resolve({ params, body });
}

describe("putPageTags effect", () => {
  test("a non-empty list replaces the page's assignment row", () => {
    const [t] = resolve(
      putPageTags as never,
      { pageId: "p1" },
      { tagIds: ["a", "b"] },
    ).targets;
    if (t?.kind !== "row") throw new Error("expected a row target");
    expect(t.id).toBe("p1");
    expect(t.removes).toBe(false);
    expect(t.enters).toBe(true);
    expect(t.apply(undefined)).toEqual({ pageId: "p1", tagIds: ["a", "b"] });
    expect(t.set).toEqual({ tagIds: ["a", "b"] });
  });

  test("an empty list removes it", () => {
    const [t] = resolve(
      putPageTags as never,
      { pageId: "p1" },
      { tagIds: [] },
    ).targets;
    if (t?.kind !== "row") throw new Error("expected a row target");
    expect(t.removes).toBe(true);
    expect(t.id).toBe("p1");
  });
});

describe("deletePageTag effect", () => {
  test("removes the vocabulary row", () => {
    const [t] = resolve(deletePageTag as never, { tagId: "t1" }).targets;
    expect(t).toMatchObject({ kind: "row", id: "t1", removes: true });
  });
});
