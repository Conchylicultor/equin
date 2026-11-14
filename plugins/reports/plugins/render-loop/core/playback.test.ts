import { describe, expect, it } from "bun:test";
import { holdPlayback, playbackHeld } from "./playback";

describe("holdPlayback", () => {
  it("is held while any hold is open, and a release is idempotent", () => {
    expect(playbackHeld()).toBe(false);
    const a = holdPlayback();
    const b = holdPlayback();
    expect(playbackHeld()).toBe(true);
    a();
    a();
    expect(playbackHeld()).toBe(true);
    b();
    expect(playbackHeld()).toBe(false);
  });
});
