import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { recordPlay } from "./endpoints";

const SLICE = "sonata_songs_ext_playback";

describe("recordPlay effect", () => {
  test("adds one play and stamps the last-played time on the held song row's playback slice", () => {
    const [t] = readLiveEffect(recordPlay.effect).resolve({
      params: { id: "s1" },
      body: undefined,
    }).targets;
    if (t === undefined || t.kind !== "rows") throw new Error("rows target");
    expect(t.subject).toBe("sonata_songs");
    expect(t.ids).toEqual(["s1"]);
    const [row] = t.apply([
      {
        id: "s1",
        title: "x",
        $columns: { [SLICE]: { playCount: 2, lastPlayedAt: null } },
      },
    ]);
    const slice = (row?.$columns as Record<string, Record<string, unknown>>)[
      SLICE
    ];
    expect(row?.title).toBe("x");
    expect(slice?.playCount).toBe(3);
    expect(slice?.lastPlayedAt).toBeInstanceOf(Date);
    // A read that does not carry the playback slice is left as it is.
    const bare = { id: "s1", $columns: {} };
    expect(t.apply([bare])[0]).toBe(bare);
  });
});
