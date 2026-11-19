import { describe, expect, it } from "bun:test";
import { MediaPlayError, playMedia } from "./media-play";

/** A media element as far as playMedia reads one. */
function fakeMedia(opts: {
  rejectWith?: unknown;
  error?: { code: number; message: string } | null;
}): HTMLMediaElement {
  return {
    tagName: "VIDEO",
    currentSrc: "https://example.test/film.mp4",
    getAttribute: () => null,
    readyState: 1,
    networkState: 2,
    error: opts.error ?? null,
    play: () =>
      opts.rejectWith === undefined
        ? Promise.resolve()
        : Promise.reject(opts.rejectWith),
  } as unknown as HTMLMediaElement;
}

const dom = (name: string) =>
  new DOMException("The operation is not supported.", name);

describe("playMedia", () => {
  it("answers playing", async () => {
    expect(await playMedia(fakeMedia({}))).toEqual({ kind: "playing" });
  });

  it("answers the autoplay policy as no-gesture", async () => {
    const el = fakeMedia({ rejectWith: dom("NotAllowedError") });
    expect(await playMedia(el)).toEqual({
      kind: "refused",
      reason: "no-gesture",
    });
  });

  it("answers an overtaken play", async () => {
    const el = fakeMedia({ rejectWith: dom("AbortError") });
    expect(await playMedia(el)).toEqual({
      kind: "refused",
      reason: "overtaken",
    });
  });

  it("answers a failed source with the element's own error (iPhone Safari's NotSupportedError)", async () => {
    const error = { code: 4, message: "" };
    const el = fakeMedia({ rejectWith: dom("NotSupportedError"), error });
    expect(await playMedia(el)).toEqual({
      kind: "refused",
      reason: "source-failed",
      error: error as unknown as MediaError,
    });
  });

  it("throws a NotSupportedError the element does not report, with its state and the cause", async () => {
    const cause = dom("NotSupportedError");
    const el = fakeMedia({ rejectWith: cause });
    let thrown: unknown;
    try {
      await playMedia(el);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MediaPlayError);
    const e = thrown as MediaPlayError;
    expect(e.cause).toBe(cause);
    expect(e.message).toContain("NotSupportedError");
    expect(e.message).toContain("src=https://example.test/film.mp4");
    expect(e.message).toContain("error=none");
    expect(e.stack).toContain("media-play.test");
  });
});
