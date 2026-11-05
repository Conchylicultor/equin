import { describe, expect, test } from "bun:test";
import { emojibaseResolver, toEmojiData } from "./emojibase";

const MESSAGES = {
  groups: [
    { key: "smileys-emotion", message: "smileys & emotion", order: 0 },
    { key: "people-body", message: "people & body", order: 1 },
    { key: "component", message: "components", order: 2 },
    { key: "flags", message: "flags", order: 9 },
  ],
  subgroups: [
    { key: "face-smiling", message: "smiling", order: 0 },
    { key: "hand-fingers-open", message: "hand fingers open", order: 15 },
    { key: "family", message: "family", order: 40 },
    { key: "flag", message: "flag", order: 98 },
    { key: "country-flag", message: "country flag", order: 99 },
    { key: "subdivision-flag", message: "subdivision-flag", order: 100 },
  ],
  skinTones: [
    { key: "dark", message: "dark skin tone" },
    { key: "light", message: "light skin tone" },
    { key: "medium", message: "medium skin tone" },
    { key: "medium-dark", message: "medium-dark skin tone" },
    { key: "medium-light", message: "medium-light skin tone" },
  ],
};

const DATA = [
  // A component: no group, never offered.
  { label: "regional indicator A", emoji: "🇦", version: 0, type: 1 },
  {
    label: "grinning face",
    emoji: "😀",
    group: 0,
    subgroup: 0,
    version: 1,
    tags: ["face", "grin"],
  },
  {
    label: "waving hand",
    emoji: "👋",
    group: 1,
    subgroup: 15,
    version: 0.6,
    tags: ["hand", "wave"],
    skins: [
      { emoji: "👋🏻", tone: 1 },
      { emoji: "👋🏼", tone: 2 },
      { emoji: "👋🏽", tone: 3 },
      { emoji: "👋🏾", tone: 4 },
      { emoji: "👋🏿", tone: 5 },
    ],
  },
  {
    label: "people holding hands",
    emoji: "🧑‍🤝‍🧑",
    group: 1,
    subgroup: 40,
    version: 12,
    skins: [
      { emoji: "🧑🏻‍🤝‍🧑🏻", tone: 1 },
      { emoji: "🧑🏻‍🤝‍🧑🏼", tone: [1, 2] },
    ],
  },
  { label: "flag: France", emoji: "🇫🇷", group: 9, subgroup: 99, version: 2 },
  { label: "chequered flag", emoji: "🏁", group: 9, subgroup: 98, version: 1 },
  {
    label: "flag: England",
    emoji: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
    group: 9,
    subgroup: 100,
    version: 5,
  },
];

describe("toEmojiData", () => {
  const data = toEmojiData(DATA, MESSAGES);

  test("categories are the groups but components, labels capitalized", () => {
    expect(data.categories).toEqual([
      { index: 0, label: "Smileys & emotion" },
      { index: 1, label: "People & body" },
      { index: 9, label: "Flags" },
    ]);
    expect(data.skinTones.light).toBe("Light skin tone");
    expect(data.locale).toBe("en");
  });

  test("components are dropped; labels and tags carried", () => {
    expect(data.emojis.map((e) => e.emoji)).toEqual([
      "😀",
      "👋",
      "🧑‍🤝‍🧑",
      "🇫🇷",
      "🏁",
      "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
    ]);
    expect(data.emojis[0]).toEqual({
      emoji: "😀",
      category: 0,
      version: 1,
      label: "Grinning face",
      tags: ["face", "grin"],
      countryFlag: undefined,
      skins: undefined,
      aliases: undefined,
    });
  });

  test("single-tone skins are keyed by tone; multi-tone ones are aliases", () => {
    expect(data.emojis[1]!.skins).toEqual({
      light: "👋🏻",
      "medium-light": "👋🏼",
      medium: "👋🏽",
      "medium-dark": "👋🏾",
      dark: "👋🏿",
    });
    expect(data.emojis[2]!.skins).toEqual({ light: "🧑🏻‍🤝‍🧑🏻" } as never);
    expect(data.emojis[2]!.aliases).toEqual(["🧑🏻‍🤝‍🧑🏼"]);
  });

  test("a country flag is marked, another flag (a subdivision's too) is not", () => {
    expect(data.emojis[3]!.countryFlag).toBe(true);
    expect(data.emojis[4]!.countryFlag).toBeUndefined();
    expect(data.emojis[5]!.countryFlag).toBeUndefined();
  });

  test("a malformed file throws instead of drawing an empty grid", () => {
    expect(() => toEmojiData({ not: "a list" }, MESSAGES)).toThrow();
    expect(() =>
      toEmojiData(DATA, {
        ...MESSAGES,
        skinTones: MESSAGES.skinTones.slice(1),
      }),
    ).toThrow(/skin tone "dark"/);
  });
});

describe("emojibaseResolver", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  test("reads both files under the base once, and caps by version", async () => {
    const asked: string[] = [];
    const resolve = emojibaseResolver(
      "/base",
      async (url) => {
        asked.push(url);
        return json(url.endsWith("data.json") ? DATA : MESSAGES);
      },
      () => true,
    );
    const capped = await resolve("en", { emojiVersion: 1 });
    expect(capped.emojis.map((e) => e.emoji)).toEqual(["😀", "👋", "🏁"]);
    const all = await resolve("en", {});
    expect(all.emojis).toHaveLength(6);
    expect(asked.sort()).toEqual([
      "/base/en/data.json",
      "/base/en/messages.json",
    ]);
  });

  test("a failed load is not kept: the next resolve asks again", async () => {
    let calls = 0;
    const resolve = emojibaseResolver(
      "/base",
      async (url) => {
        calls += 1;
        if (calls <= 2) return json({ error: "down" }, 503);
        return json(url.endsWith("data.json") ? DATA : MESSAGES);
      },
      () => true,
    );
    expect(resolve("en", {})).rejects.toThrow(/HTTP 503/);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const data = await resolve("en", {});
    expect(data.emojis).toHaveLength(6);
  });

  test("country flags are left out where the browser cannot draw them", async () => {
    const resolve = emojibaseResolver(
      "/base",
      async (url) => json(url.endsWith("data.json") ? DATA : MESSAGES),
      () => false,
    );
    const data = await resolve("en", {});
    expect(data.emojis.map((e) => e.emoji)).not.toContain("🇫🇷");
    expect(data.emojis.map((e) => e.emoji)).toContain("🏁");
    expect(data.emojis.map((e) => e.emoji)).toContain("🏴󠁧󠁢󠁥󠁮󠁧󠁿");
  });
});
