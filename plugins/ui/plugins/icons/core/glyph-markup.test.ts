import { describe, expect, it } from "bun:test";
import type { IconifyJSON } from "@iconify/types";
import { resolveIcon } from "./glyph-markup";

const set: IconifyJSON = {
  prefix: "test",
  width: 24,
  height: 24,
  icons: {
    forum: { body: '<path d="M1"/>' },
    wide: { body: '<path d="M2"/>', width: 32 },
  },
  aliases: {
    "forum-outline": { parent: "forum" },
    "forum-outline-rounded": { parent: "forum-outline" },
    flipped: { parent: "forum", hFlip: true },
  },
};

describe("resolveIcon", () => {
  it("follows alias chains to the parent's body and the set's box", () => {
    expect(resolveIcon(set, "forum-outline-rounded")).toEqual({
      body: '<path d="M1"/>',
      width: 24,
      height: 24,
    });
  });

  it("keeps an icon's own box", () => {
    expect(resolveIcon(set, "wide").width).toBe(32);
  });

  it("throws on a name the set does not have", () => {
    expect(() => resolveIcon(set, "nope")).toThrow(/not in the test icon set/);
  });

  it("throws on an alias that transforms its parent", () => {
    expect(() => resolveIcon(set, "flipped")).toThrow(/hFlip/);
  });
});
