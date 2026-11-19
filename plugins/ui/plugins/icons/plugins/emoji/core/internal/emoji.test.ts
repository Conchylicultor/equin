import { describe, expect, test } from "bun:test";
import { EMOJI_SEQUENCE_SOURCE, EmojiSchema, isEmoji } from "./emoji";

const ACCEPTED: [string, string][] = [
  ["simple", "🚀"],
  ["ZWJ family", "👨‍👩‍👧‍👦"],
  ["skin tone", "👍🏽"],
  ["flag", "🇫🇷"],
  ["keycap", "1️⃣"],
  ["VS16 (map)", "🗺️"],
  ["ZWJ pirate flag", "🏴‍☠️"],
  ["ZWJ rainbow flag", "🏳️‍🌈"],
  ["ZWJ with skin tone", "👩🏽‍💻"],
  ["subdivision flag", "🏴󠁧󠁢󠁳󠁣󠁴󠁿"],
];

const REJECTED: [string, string][] = [
  ["letters", "ab"],
  ["a word", "rocket"],
  ["empty", ""],
  ["two emoji", "🚀🚀"],
  ["emoji plus text", "🚀x"],
  ["a digit", "1"],
  ["whitespace around", " 🚀"],
  ["text-default without VS16", "🗺"],
];

describe("isEmoji", () => {
  test.each(ACCEPTED)("accepts %s", (_label, s) => {
    expect(isEmoji(s)).toBe(true);
  });
  test.each(REJECTED)("rejects %s", (_label, s) => {
    expect(isEmoji(s)).toBe(false);
  });
});

// The spelling an engine without the `v` flag uses (Safari < 17) agrees with
// the RGI one Bun uses (isEmoji above) on every case.
describe("without the v flag", () => {
  const re = new RegExp(EMOJI_SEQUENCE_SOURCE, "u");
  test.each(ACCEPTED)("accepts %s", (_label, s) => {
    expect(re.test(s)).toBe(true);
  });
  test.each(REJECTED)("rejects %s", (_label, s) => {
    expect(re.test(s)).toBe(false);
  });
});

describe("EmojiSchema", () => {
  test("parses an emoji", () => {
    expect<string>(EmojiSchema.parse("🧪")).toBe("🧪");
  });
  test("rejects a symbol name", () => {
    expect(EmojiSchema.safeParse("description").success).toBe(false);
  });
});
