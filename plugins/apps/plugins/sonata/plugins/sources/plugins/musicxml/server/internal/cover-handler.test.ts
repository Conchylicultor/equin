import { describe, expect, test } from "bun:test";
import type { ScoreCoverRequest } from "@plugins/apps/plugins/sonata/plugins/covers/server";
import {
  createMusicXmlCoverHandler,
  type MusicXmlCoverSong,
} from "./cover-handler";

const NOTES = ["C", "E", "G", "C"]
  .map(
    (step, i) =>
      `<note><pitch><step>${step}</step><octave>${i === 3 ? 5 : 4}</octave></pitch><duration>4</duration><type>quarter</type></note>`,
  )
  .join("");

/** A one-bar, one-part document. */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${NOTES}</measure>
  </part>
</score-partwise>`;

const SONG: MusicXmlCoverSong = {
  current: "1700000000000",
  contentHash: "hash-1",
  readXml: async () => XML,
};

/** The handler over a lookup of one song, recording what reaches `serve`. */
function setup(song: MusicXmlCoverSong | null = SONG) {
  const served: ScoreCoverRequest[] = [];
  const handler = createMusicXmlCoverHandler({
    lookup: async () => song,
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
  return { get, served };
}

describe("MusicXML cover route", () => {
  test("400 for a last segment that is not <integer>.svg", async () => {
    const { get, served } = setup();
    for (const file of ["abc.svg", "12.png", "1.5.svg", "12", ""]) {
      expect((await get(file)).status).toBe(400);
    }
    expect(served).toEqual([]);
  });

  test("404 for a song without MusicXML", async () => {
    const { get, served } = setup(null);
    expect((await get("1700000000000.svg")).status).toBe(404);
    expect(served).toEqual([]);
  });

  test("serves the staff cover, keyed by the content hash, at the current version", async () => {
    const { get, served } = setup();
    const res = await get("1700000000000.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("immutable");
    expect(await res.text()).toStartWith("<svg");
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

  test("a malformed document rejects the render", async () => {
    const { get } = setup({ ...SONG, readXml: async () => "<nope" });
    let thrown: unknown = null;
    try {
      await get("1700000000000.svg");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});
