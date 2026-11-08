import { describe, expect, it } from "bun:test";
import type { IconifyJSON } from "@iconify/types";
import { buildSprite } from "./build-sprite";

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

describe("buildSprite", () => {
  it("wraps one <symbol> per entry, under the entry's id", () => {
    expect(
      buildSprite([
        {
          id: "ms-default-outline-400-forum",
          set,
          iconifyName: "forum-outline",
        },
        { id: "ms-default-outline-400-wide", set, iconifyName: "wide" },
      ]),
    ).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<symbol id="ms-default-outline-400-forum" viewBox="0 0 24 24"><path d="M1"/></symbol>' +
        '<symbol id="ms-default-outline-400-wide" viewBox="0 0 32 24"><path d="M2"/></symbol>' +
        "</svg>",
    );
  });

  it("is an empty sprite for no entries", () => {
    expect(buildSprite([])).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
  });
});
