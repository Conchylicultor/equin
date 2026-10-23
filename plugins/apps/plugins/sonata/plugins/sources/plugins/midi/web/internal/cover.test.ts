import { describe, expect, test } from "bun:test";
import type { Song } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { midiCover } from "./cover";

const AT = new Date(1_700_000_000_000);
const song = (source: string) =>
  ({ id: "song-1", source, sourcesChangedAt: AT }) as Song;

describe("midiCover", () => {
  test("a MIDI song's cover is its versioned roll SVG", () => {
    expect(midiCover(song("midi"))).toEqual({
      kind: "art",
      content: {
        kind: "image",
        src: "/api/sonata/songs/song-1/midi/cover/1700000000000.svg",
      },
    });
  });

  test("any other song is not its to answer for", () => {
    expect(midiCover(song("musicxml"))).toBeUndefined();
  });
});
