import { describe, expect, test } from "bun:test";
import { AVATAR_COLOR_NAMES, avatarColorPick } from "../../core";
import {
  AVATAR_COLORS,
  avatarColorClass,
  avatarFlatClass,
  avatarSoftClass,
} from "./colors";

/**
 * The soft (badge) class for a fixed key set, captured from the implementation
 * BEFORE the pick was split into { slot, shade }. Pinning it proves that adding
 * the tile shade changed no existing avatar's colour.
 */
const SOFT_BEFORE: [string, string][] = [
  ["home", "bg-categorical-3/15 text-categorical-3"],
  ["settings", "bg-categorical-1/15 text-categorical-1"],
  ["pages", "bg-categorical-6/15 text-categorical-6"],
  ["agent-manager", "bg-categorical-3/15 text-categorical-3"],
  ["debug", "bg-categorical-5/15 text-categorical-5"],
  ["sonata", "bg-categorical-4/15 text-categorical-4"],
  ["mail", "bg-categorical-5/15 text-categorical-5"],
  ["browser", "bg-categorical-2/15 text-categorical-2"],
  ["studio", "bg-categorical-6/15 text-categorical-6"],
  ["events", "bg-categorical-3/15 text-categorical-3"],
  ["deploy", "bg-categorical-7/15 text-categorical-7"],
  ["prototypes", "bg-categorical-1/15 text-categorical-1"],
  ["website", "bg-categorical-7/15 text-categorical-7"],
  ["file-explorer", "bg-categorical-6/15 text-categorical-6"],
  ["att-1789590981-nj3y", "bg-categorical-2/15 text-categorical-2"],
  ["att-1789509871-llga", "bg-categorical-8/15 text-categorical-8"],
  ["c-0f3a9b2e", "bg-categorical-4/15 text-categorical-4"],
  ["conv-42", "bg-categorical-3/15 text-categorical-3"],
  ["general", "bg-categorical-4/15 text-categorical-4"],
  ["bugs", "bg-categorical-7/15 text-categorical-7"],
  ["features", "bg-categorical-3/15 text-categorical-3"],
  ["research", "bg-categorical-5/15 text-categorical-5"],
  ["refactor", "bg-categorical-8/15 text-categorical-8"],
  ["infra", "bg-categorical-8/15 text-categorical-8"],
  ["ui", "bg-categorical-2/15 text-categorical-2"],
  ["docs", "bg-categorical-7/15 text-categorical-7"],
  ["robot", "bg-categorical-2/15 text-categorical-2"],
  ["rocket", "bg-categorical-2/15 text-categorical-2"],
  ["a", "bg-categorical-5/15 text-categorical-5"],
  ["Z", "bg-categorical-8/15 text-categorical-8"],
  ["", "bg-muted"],
];

describe("avatarColorClass (soft, badge)", () => {
  test.each(SOFT_BEFORE)(
    "key %p keeps its pre-shade class",
    (key, expected) => {
      expect(avatarColorClass(null, key)).toBe(expected);
    },
  );

  test("an explicit colour wins over the key", () => {
    expect(avatarColorClass("teal", "home")).toBe(
      "bg-categorical-7/15 text-categorical-7",
    );
  });

  test("an unknown colour falls back to the key", () => {
    expect(avatarColorClass("nope", "home")).toBe(
      "bg-categorical-3/15 text-categorical-3",
    );
  });

  test("no colour and no key is the muted box", () => {
    expect(avatarColorClass(null)).toBe("bg-muted");
  });

  test("a prototype key is not a colour", () => {
    expect(avatarColorPick("constructor", undefined)).toBeNull();
  });
});

describe("avatarColorPick", () => {
  test("an explicit colour is shade 0", () => {
    expect(avatarColorPick("slate", "home")).toEqual({
      slot: "slate",
      shade: 0,
    });
  });

  test("soft paint is the slot's class regardless of shade", () => {
    expect(avatarSoftClass({ slot: "rose", shade: 1 })).toBe(
      AVATAR_COLORS.rose,
    );
    expect(avatarSoftClass({ slot: "rose", shade: 0 })).toBe(
      AVATAR_COLORS.rose,
    );
  });

  test("automatic picks spread over all 8 slots × 2 shades", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const pick = avatarColorPick(null, `key-${i}`)!;
      seen.add(`${pick.slot}:${pick.shade}`);
    }
    expect(seen.size).toBe(16);
    expect(
      [...seen].some((s) => s.startsWith("orange") || s.startsWith("slate")),
    ).toBe(false);
  });
});

describe("avatarFlatClass (tile)", () => {
  test.each(AVATAR_COLOR_NAMES.map((name, i) => [name, i + 1] as const))(
    "%s: shade 0 is the solid slot, shade 1 the slot lifted 0.13",
    (slot, n) => {
      expect(avatarFlatClass({ slot, shade: 0 })).toBe(
        `bg-categorical-${n} text-categorical-foreground`,
      );
      expect(avatarFlatClass({ slot, shade: 1 })).toBe(
        `bg-categorical-${n}-lift text-categorical-foreground`,
      );
    },
  );

  test("no pick is a muted tile", () => {
    expect(avatarFlatClass(null)).toBe("bg-muted text-foreground");
  });
});
