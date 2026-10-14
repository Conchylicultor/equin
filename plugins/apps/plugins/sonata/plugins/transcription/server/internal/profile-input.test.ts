import { describe, expect, test } from "bun:test";
import { TranscriptionInputSchema } from "../../shared/input";
import { inputFilePath, ProfileInputSchema } from "./profile-input";
import { transcriptionInstructions } from "./instructions";

describe("TranscriptionInputSchema", () => {
  test("a link or at least one upload", () => {
    expect(
      TranscriptionInputSchema.parse({
        kind: "url",
        url: "https://www.instagram.com/p/Dd7oBnUua5Y/",
      }).kind,
    ).toBe("url");
    expect(
      TranscriptionInputSchema.safeParse({ kind: "url", url: "not a url" })
        .success,
    ).toBe(false);
    expect(
      TranscriptionInputSchema.safeParse({ kind: "files", attachmentIds: [] })
        .success,
    ).toBe(false);
    expect(
      TranscriptionInputSchema.parse({ kind: "files", attachmentIds: ["a"] })
        .kind,
    ).toBe("files");
  });
});

describe("ProfileInputSchema", () => {
  test("requires the song and a source", () => {
    expect(
      ProfileInputSchema.safeParse({
        songId: "song-1",
        source: {
          kind: "files",
          files: [{ attachmentId: "a", name: "p.png" }],
        },
      }).success,
    ).toBe(true);
    expect(
      ProfileInputSchema.safeParse({
        source: { kind: "url", url: "https://x.test/" },
      }).success,
    ).toBe(false);
    expect(
      ProfileInputSchema.safeParse({
        songId: "song-1",
        source: { kind: "files", files: [] },
      }).success,
    ).toBe(false);
  });
});

describe("inputFilePath", () => {
  test("numbers uploads in order, keeping a plain name", () => {
    expect(inputFilePath(0, "page 1.png")).toBe("input/01-page 1.png");
    expect(inputFilePath(11, "score.pdf")).toBe("input/12-score.pdf");
  });

  test("never leaves input/", () => {
    expect(inputFilePath(0, "../../etc/passwd")).toBe("input/01-passwd");
    expect(inputFilePath(0, "..\\..\\win.png")).toBe("input/01-win.png");
    expect(inputFilePath(0, "..")).toBe("input/01-file");
    expect(inputFilePath(0, ".hidden")).toBe("input/01-hidden");
    expect(inputFilePath(0, "a/b:c*?.png")).toBe("input/01-b_c__.png");
  });
});

describe("transcriptionInstructions", () => {
  test("a link source tells the agent to fetch and extract frames", () => {
    const md = transcriptionInstructions({
      songId: "song-1",
      source: { kind: "url", url: "https://www.instagram.com/p/X/" },
    });
    expect(md).toContain(
      "./bin/st fetch 'https://www.instagram.com/p/X/' --out input",
    );
    expect(md).toContain("./bin/st frames input/video.mp4 --out frames");
    expect(md).toContain("sonata_submit_transcription");
    expect(md).toContain("then call `exit_clean`");
  });

  test("an upload source lists the copied files, rendering PDFs to pages", () => {
    const md = transcriptionInstructions({
      songId: "song-1",
      source: {
        kind: "files",
        files: [
          { attachmentId: "a", name: "p1.jpg" },
          { attachmentId: "b", name: "rest.pdf" },
        ],
      },
    });
    expect(md).toContain("`input/01-p1.jpg` — an image");
    expect(md).toContain("./bin/st pages input/02-rest.pdf --out frames/02");
    expect(md).not.toContain("./bin/st fetch '");
  });
});
