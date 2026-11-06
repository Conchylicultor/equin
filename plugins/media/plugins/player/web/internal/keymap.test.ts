import { describe, expect, test } from "bun:test";
import { PLAYER_KEYS, matchesKeys } from "./keymap";

const key = (k: string, shift = false) => ({
  key: k,
  shiftKey: shift,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
});

describe("matchesKeys", () => {
  test("plain keys, case-insensitive, no shift", () => {
    expect(matchesKeys("m", key("m"))).toBe(true);
    expect(matchesKeys("arrowleft", key("ArrowLeft"))).toBe(true);
    expect(matchesKeys("m", key("M", true))).toBe(false);
  });
  test("shifted keys need shift", () => {
    expect(matchesKeys("shift+>", key(">", true))).toBe(true);
    expect(matchesKeys("shift+>", key(">"))).toBe(false);
  });
  test("a held modifier is never the player's", () => {
    expect(matchesKeys("m", { ...key("m"), metaKey: true })).toBe(false);
  });
  test("every digit jumps", () => {
    for (let d = 0; d <= 9; d++)
      expect(PLAYER_KEYS.some((k) => matchesKeys(k.keys, key(`${d}`)))).toBe(
        true,
      );
  });
});
