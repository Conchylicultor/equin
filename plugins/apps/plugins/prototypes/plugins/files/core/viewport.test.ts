import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROTOTYPE_VIEWPORT,
  PROTOTYPE_VIEWPORT_WORDS,
  SIZE_PRESETS,
  parseViewport,
  viewportRenderSize,
} from "./viewport";

describe("parseViewport", () => {
  test("absent or blank is the default, not a problem", () => {
    expect(parseViewport(undefined)).toEqual({
      ok: true,
      viewport: DEFAULT_PROTOTYPE_VIEWPORT,
    });
    expect(parseViewport("  ")).toEqual({
      ok: true,
      viewport: DEFAULT_PROTOTYPE_VIEWPORT,
    });
  });

  test("window", () => {
    expect(parseViewport(" Window ")).toEqual({
      ok: true,
      viewport: { kind: "window" },
    });
  });

  test("responsive", () => {
    expect(parseViewport("responsive")).toEqual({
      ok: true,
      viewport: { kind: "responsive" },
    });
  });

  test("every preset, by its word, case and spaces ignored", () => {
    for (const p of SIZE_PRESETS) {
      expect(parseViewport(` ${p.word.toUpperCase()} `)).toEqual({
        ok: true,
        viewport: { kind: "preset", preset: p.name },
      });
    }
  });

  test("the words list is exactly what parses", () => {
    for (const word of PROTOTYPE_VIEWPORT_WORDS) {
      expect(parseViewport(word).ok).toBe(true);
    }
  });

  test("the retired WxH form and unknown words are refused", () => {
    expect(parseViewport("1320x868")).toEqual({ ok: false, raw: "1320x868" });
    expect(parseViewport("mobile")).toEqual({ ok: false, raw: "mobile" });
  });
});

describe("viewportRenderSize", () => {
  test("a preset renders at its size; window and responsive at the headless preset's", () => {
    expect(viewportRenderSize({ kind: "preset", preset: "Phone" })).toEqual({
      w: 390,
      h: 844,
    });
    expect(viewportRenderSize({ kind: "responsive" })).toEqual({
      w: 1440,
      h: 900,
    });
    expect(viewportRenderSize({ kind: "window" })).toEqual({
      w: 1440,
      h: 900,
    });
  });
});
