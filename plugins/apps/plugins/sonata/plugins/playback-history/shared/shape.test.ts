/**
 * The play stats every list of songs derives from the playback exposure: the
 * ids the library's sort presets ("Most played", "Recently played") and filter
 * preset ("Unplayed") name are unchanged, and a song with no playback row reads
 * `playCount` 0 (its declared default) and `lastPlayedAt` null.
 *
 * Run: `./singularity test plugins/apps/plugins/sonata/plugins/playback-history`.
 */

import { describe, expect, test } from "bun:test";
import { playbackHistoryShape } from "./shape";

describe("playback exposure", () => {
  test("exposes playCount and lastPlayedAt on the songs entity, under their persisted ids", () => {
    const { exposure } = playbackHistoryShape;
    expect(exposure.parent.name).toBe("sonata_songs");
    expect(exposure.slice).toBe("sonata_songs_ext_playback");
    expect(Object.values(exposure.fields).map((f) => f.id)).toEqual([
      "playCount",
      "lastPlayedAt",
    ]);
    expect(exposure.fields.playCount).toMatchObject({
      label: "Plays",
      absent: 0,
    });
    expect(exposure.fields.lastPlayedAt).toMatchObject({
      label: "Last played",
      absent: null,
    });
  });
});
