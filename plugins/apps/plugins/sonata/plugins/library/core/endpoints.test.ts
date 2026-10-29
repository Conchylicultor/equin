import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { deleteSong, updateSong } from "./endpoints";

function row(effect: Parameters<typeof readLiveEffect>[0], body: unknown) {
  const [t] = readLiveEffect(effect).resolve({
    params: { id: "s1" },
    body,
  }).targets;
  if (t === undefined || t.kind !== "row") throw new Error("row target");
  return t;
}

describe("song effects", () => {
  test("updateSong sets only the fields the request carries", () => {
    expect(row(updateSong.effect, { title: "New" }).set).toEqual({
      title: "New",
    });
    expect(row(updateSong.effect, { composer: null }).set).toEqual({
      composer: null,
    });
  });

  test("deleteSong removes the song row", () => {
    const t = row(deleteSong.effect, undefined);
    expect(t.subject).toBe("sonata_songs");
    expect(t.apply({ id: "s1" })).toBeUndefined();
  });
});
