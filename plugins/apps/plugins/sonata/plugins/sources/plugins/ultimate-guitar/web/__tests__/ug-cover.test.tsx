import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Song } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { UG_SOURCE_ID } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import { ugCover } from "../components/ug-cover";

afterEach(cleanup);

/** A listed song as the library reads it: only what the cover reads. */
function song(
  source: string,
  columns: { key?: string | null; videoId?: string | null } = {},
): Song {
  return {
    id: "song-1",
    source,
    $columns: {
      sonata_songs_ext_ultimate_guitar: { key: columns.key ?? null },
      sonata_songs_ext_ug_alignment: { videoId: columns.videoId ?? null },
    },
  } as unknown as Song;
}

/** Render the cover's node and return its container. */
function draw(s: Song): HTMLElement {
  const answer = ugCover(s);
  if (answer?.kind !== "art" || answer.content.kind !== "node") {
    throw new Error(`expected node art, got ${JSON.stringify(answer)}`);
  }
  return render(<div className="relative">{answer.content.node}</div>)
    .container;
}

describe("ugCover", () => {
  it("answers nothing for another source's song", () => {
    expect(ugCover(song("midi", { videoId: "abc", key: "C" }))).toBeUndefined();
  });

  it("with a video: its thumbnail and a Key badge", () => {
    const c = draw(song(UG_SOURCE_ID, { videoId: "dQw4w9WgXcQ", key: "Am" }));
    expect(c.querySelector("img")?.getAttribute("src")).toBe(
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
    );
    expect(c.textContent).toContain("Key Am");
  });

  it("with a video and no key: the thumbnail, no badge", () => {
    const c = draw(song(UG_SOURCE_ID, { videoId: "dQw4w9WgXcQ" }));
    expect(c.querySelector("img")).not.toBeNull();
    expect(c.textContent).not.toContain("Key");
  });

  it("without a video: the sheet cover with the key watermark", () => {
    const c = draw(song(UG_SOURCE_ID, { key: "G" }));
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("svg text")?.textContent).toBe("G");
  });

  it("without a video or key: the sheet cover alone", () => {
    const c = draw(song(UG_SOURCE_ID));
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("svg text")).toBeNull();
  });
});
