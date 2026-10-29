import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { setSwingEndpoint } from "./endpoints";

function target(body: unknown) {
  const [t] = readLiveEffect(setSwingEndpoint.effect).resolve({
    params: { id: "s1" },
    body,
  }).targets;
  if (t === undefined || t.kind !== "row") throw new Error("row target");
  return t;
}

describe("setSwingEndpoint effect", () => {
  test("score deletes the song's row", () => {
    const t = target({ kind: "score" });
    expect(t.subject).toBe("collection:sonata-swing");
    expect(t.removes).toBe(true);
    expect(t.apply({ songId: "s1" })).toBeUndefined();
  });

  test("straight upserts a not-swung row keeping the feel", () => {
    const t = target({ kind: "straight", feel: { unit: 16, ratio: 1.5 } });
    expect(t.enters).toBe(true);
    expect(t.apply(undefined)).toEqual({
      songId: "s1",
      swung: false,
      unit: 16,
      ratio: 1.5,
    });
  });

  test("swing upserts a swung row", () => {
    const t = target({ kind: "swing", swing: { unit: 8, ratio: 2 } });
    expect(t.apply({ songId: "s1", swung: false, unit: 16, ratio: 1 })).toEqual(
      { songId: "s1", swung: true, unit: 8, ratio: 2 },
    );
  });
});
