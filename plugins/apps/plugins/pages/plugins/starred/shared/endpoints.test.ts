import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { putPageStarred } from "./endpoints";

function target(starred: boolean) {
  const [t] = readLiveEffect(putPageStarred.effect).resolve({
    params: { pageId: "p1" },
    body: { starred },
  }).targets;
  if (t === undefined || t.kind !== "row") throw new Error("row target");
  return t;
}

describe("putPageStarred effect", () => {
  test("starring upserts the page's presence row", () => {
    const t = target(true);
    expect(t.enters).toBe(true);
    expect(t.apply(undefined)).toMatchObject({ blockId: "p1" });
  });

  test("unstarring removes it", () => {
    const t = target(false);
    expect(t.removes).toBe(true);
    expect(t.apply({ blockId: "p1" })).toBeUndefined();
  });
});
