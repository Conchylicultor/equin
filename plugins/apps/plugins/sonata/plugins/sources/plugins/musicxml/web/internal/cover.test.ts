import { describe, expect, test } from "bun:test";
import type { Song } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { musicXmlCover } from "./cover";
import { musicXmlCoverAsset } from "../../shared/endpoints";

const AT = new Date(1_700_000_000_000);
const song = (source: string) =>
  ({ id: "song-1", source, sourcesChangedAt: AT }) as Song;

describe("musicXmlCover", () => {
  test("a MusicXML song's cover is its versioned staff SVG", () => {
    expect(musicXmlCover(song("musicxml"))).toEqual({
      kind: "art",
      content: {
        kind: "asset",
        asset: musicXmlCoverAsset(song("musicxml").id, AT),
      },
    });
  });

  test("any other song is not its to answer for", () => {
    expect(musicXmlCover(song("midi"))).toBeUndefined();
  });
});
