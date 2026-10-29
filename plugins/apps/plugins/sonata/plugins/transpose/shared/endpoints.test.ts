import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { setTransposeEndpoint } from "./endpoints";

describe("setTransposeEndpoint effect", () => {
  const [t] = readLiveEffect(setTransposeEndpoint.effect).resolve({
    params: { id: "s1" },
    body: { semitones: -3 },
  }).targets;

  test("upserts the song's row, compared on the offset", () => {
    if (t === undefined || t.kind !== "row") throw new Error("row target");
    expect(t.subject).toBe("collection:sonata-transpose");
    expect(t.id).toBe("s1");
    expect(t.enters).toBe(true);
    expect(t.set).toEqual({ semitones: -3 });
    expect(t.apply(undefined)).toEqual({ songId: "s1", semitones: -3 });
  });
});
