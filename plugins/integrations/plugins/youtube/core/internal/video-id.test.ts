import { describe, expect, it } from "bun:test";
import { youtubeVideoId, youtubeWatchUrl } from "./video-id";

describe("youtubeVideoId", () => {
  // The first three are spellings found in real TheoryTab sections.
  it.each([
    ["CGj85pVzRJs", "CGj85pVzRJs"],
    ["https://youtu.be/CGj85pVzRJs?si=xzYBViA1tQ7Zyvkf", "CGj85pVzRJs"],
    [
      "https://www.youtube.com/watch?v=hTWKbfoikeg&ab_channel=NirvanaVEVO",
      "hTWKbfoikeg",
    ],
    ["https://m.youtube.com/watch?v=d020hcWA_Wg", "d020hcWA_Wg"],
    ["https://www.youtube.com/embed/9KHQnlFwxzU", "9KHQnlFwxzU"],
    ["https://youtube.com/shorts/2kotK9FNEYU?feature=share", "2kotK9FNEYU"],
    ["  A_MjCqQoLLA  ", "A_MjCqQoLLA"],
  ])("reads %p as %p", (raw, id) => {
    expect(youtubeVideoId(raw)).toBe(id);
  });

  it.each([
    [""],
    ["not a video"],
    ["https://vimeo.com/76979871"],
    ["https://www.youtube.com/watch?v=short"],
    ["https://www.youtube.com/channel/UC1234567890"],
    ["https://youtu.be/"],
  ])("finds no video in %p", (raw) => {
    expect(youtubeVideoId(raw)).toBeNull();
  });
});

describe("youtubeWatchUrl", () => {
  it("links the watch page", () => {
    expect(youtubeWatchUrl("CGj85pVzRJs")).toBe(
      "https://www.youtube.com/watch?v=CGj85pVzRJs",
    );
  });

  it("starts at the whole second the playhead is in", () => {
    expect(youtubeWatchUrl("CGj85pVzRJs", 83.9)).toBe(
      "https://www.youtube.com/watch?v=CGj85pVzRJs&t=83s",
    );
  });

  it("leaves the start off under a second in", () => {
    expect(youtubeWatchUrl("CGj85pVzRJs", 0.4)).toBe(
      "https://www.youtube.com/watch?v=CGj85pVzRJs",
    );
  });
});
