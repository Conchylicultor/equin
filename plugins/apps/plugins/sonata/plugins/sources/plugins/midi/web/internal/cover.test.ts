import { describe, expect, test } from "bun:test";
import type { Song } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { midiCover } from "./cover";
import { midiCoverAsset } from "../../shared/endpoints";

const AT = new Date(1_700_000_000_000);
const song = (source: string) =>
  ({ id: "song-1", source, sourcesChangedAt: AT }) as Song;

describe("midiCover", () => {
  test("a MIDI song's cover is its versioned roll SVG", () => {
    expect(midiCover(song("midi"))).toEqual({
      kind: "art",
      content: {
        kind: "asset",
        asset: midiCoverAsset(song("midi").id, AT),
      },
    });
  });

  test("any other song is not its to answer for", () => {
    expect(midiCover(song("musicxml"))).toBeUndefined();
  });
});
