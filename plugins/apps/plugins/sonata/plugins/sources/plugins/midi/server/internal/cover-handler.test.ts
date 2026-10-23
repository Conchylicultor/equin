import { describe, expect, test } from "bun:test";
import { Midi } from "@tonejs/midi";
import type { ScoreCoverRequest } from "@plugins/apps/plugins/sonata/plugins/covers/server";
import { createMidiCoverHandler, type MidiCoverSong } from "./cover-handler";

/** A two-bar C-major arpeggio, as `.mid` bytes. */
function midiBytes(): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(120);
  const track = midi.addTrack();
  [60, 64, 67, 72, 67, 64, 60, 64].forEach((n, i) =>
    track.addNote({ midi: n, time: i * 0.5, duration: 0.5 }),
  );
  return midi.toArray();
}

const SONG: MidiCoverSong = {
  current: "1700000000000",
  contentHash: "hash-1",
  readBytes: async () => midiBytes(),
};

/** The handler over a lookup of one song, recording what reaches `serve`. */
function setup(song: MidiCoverSong | null = SONG) {
  const served: ScoreCoverRequest[] = [];
  const lookedUp: string[] = [];
  const handler = createMidiCoverHandler({
    lookup: async (id) => {
      lookedUp.push(id);
      return song;
    },
    serve: async (req) => {
      served.push(req);
      return new Response(await req.render(), {
        headers: {
          "cache-control":
            req.version === req.current ? "immutable" : "no-store",
        },
      });
    },
  });
  const get = (file: string) =>
    handler(new Request("http://x/"), { id: "song-1", file });
  return { get, served, lookedUp };
}

describe("MIDI cover route", () => {
  test("400 for a last segment that is not <integer>.svg", async () => {
    const { get, served, lookedUp } = setup();
    for (const file of ["abc.svg", "12.png", "1.5.svg", "12", "-1.svg", ""]) {
      expect((await get(file)).status).toBe(400);
    }
    expect(lookedUp).toEqual([]);
    expect(served).toEqual([]);
  });

  test("404 for a song without MIDI", async () => {
    const { get, served } = setup(null);
    expect((await get("1700000000000.svg")).status).toBe(404);
    expect(served).toEqual([]);
  });

  test("serves the roll cover, keyed by the content hash, at the current version", async () => {
    const { get, served, lookedUp } = setup();
    const res = await get("1700000000000.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("immutable");
    expect(await res.text()).toStartWith("<svg");
    expect(lookedUp).toEqual(["song-1"]);
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({
      version: "1700000000000",
      current: "1700000000000",
      contentHash: "hash-1",
    });
  });

  test("a stale version still reaches serve, with the current one beside it", async () => {
    const { get, served } = setup();
    const res = await get("1600000000000.svg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(served[0]).toMatchObject({
      version: "1600000000000",
      current: "1700000000000",
    });
  });

  test("a corrupt file rejects the render — never a stand-in image", async () => {
    const { get } = setup({
      ...SONG,
      readBytes: async () => new Uint8Array([1, 2, 3]),
    });
    let thrown: unknown = null;
    try {
      await get("1700000000000.svg");
    } catch (err) {
      thrown = err;
    }
    // @tonejs/midi throws a bare string, not an Error.
    expect(String(thrown)).toContain("Bad MIDI file");
  });
});
