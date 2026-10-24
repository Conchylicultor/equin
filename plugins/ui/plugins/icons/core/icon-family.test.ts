import { describe, expect, test } from "bun:test";
import {
  defineIconFamily,
  familyGapId,
  familyGlyphId,
  familyGlyphMarkup,
} from "./icon-family";
import { ICON_MOTIONS } from "./icon-motion";

function withBody(body: string) {
  return defineIconFamily({
    id: "motion-test",
    label: "Motion test",
    coverage: "fallback",
    stroke: 1.6,
    glyphs: { x: { body } },
    symbols: { close: "x" },
  });
}

describe("defineIconFamily — motion", () => {
  test("a glyph without moving parts is not animated, and its body is kept as written", () => {
    const f = withBody('<path d="M6 6l12 12"/>');
    expect(f.glyphs.x.animated).toBe(false);
    expect(f.glyphs.x.body).toBe('<path d="M6 6l12 12"/>');
  });

  test("a data-motion part makes the glyph animated; delay and origin become its inline style", () => {
    const f = withBody(
      '<path data-motion="nudge-right" data-motion-delay="70" data-motion-origin="12 13" d="M10 7l5 5-5 5"/>',
    );
    expect(f.glyphs.x.animated).toBe(true);
    expect(f.glyphs.x.body).toBe(
      '<path data-motion="nudge-right" data-motion-delay="70" data-motion-origin="12 13" d="M10 7l5 5-5 5" style="--icon-motion-delay:70ms;transform-box:view-box;transform-origin:12px 13px"/>',
    );
  });

  test("a draw part gets pathLength=1", () => {
    const f = withBody('<path data-motion="draw" d="M5 12l4 4"/>');
    expect(f.glyphs.x.body).toBe(
      '<path data-motion="draw" d="M5 12l4 4" pathLength="1"/>',
    );
    expect(() =>
      withBody('<g data-motion="draw"><path d="M5 12l4 4"/></g>'),
    ).toThrow(/not a <g>/);
    expect(() =>
      withBody('<path data-motion="draw" pathLength="2" d="M5 12"/>'),
    ).toThrow(/pathLength="1"/);
  });

  test("every motion of the vocabulary is accepted", () => {
    for (const m of ICON_MOTIONS) {
      expect(
        withBody(`<path data-motion="${m}" d="M1 1"/>`).glyphs.x.animated,
      ).toBe(true);
    }
  });

  test("throws on an unknown motion", () => {
    expect(() => withBody('<path data-motion="wiggle" d="M1 1"/>')).toThrow(
      /unknown motion "wiggle"/,
    );
  });

  test("throws on a malformed delay or origin, an unknown motion attribute, or a delay without a motion", () => {
    expect(() =>
      withBody('<path data-motion="pop" data-motion-delay="70ms" d="M1 1"/>'),
    ).toThrow(/data-motion-delay/);
    expect(() =>
      withBody('<path data-motion="pop" data-motion-origin="12,13" d="M1 1"/>'),
    ).toThrow(/data-motion-origin/);
    expect(() =>
      withBody('<path data-motion="pop" data-motion-speed="2" d="M1 1"/>'),
    ).toThrow(/unknown motion attribute/);
    expect(() => withBody('<path data-motion-delay="70" d="M1 1"/>')).toThrow(
      /no data-motion/,
    );
    expect(() =>
      withBody(
        '<path data-motion="pop" data-motion-delay="70" style="opacity:1" d="M1 1"/>',
      ),
    ).toThrow(/sets a style/);
  });
});

describe("defineIconFamily — coverage", () => {
  test("a strict family's sheet holds its gap glyph; a fallback family's does not", () => {
    const strict = defineIconFamily({
      id: "strict-test",
      label: "Strict",
      coverage: "strict",
      stroke: 1.6,
      glyphs: { x: { body: '<path d="M1 1"/>' } },
      symbols: { close: "x" },
    });
    expect(familyGlyphMarkup(strict)).toContain(
      `id="${familyGapId("strict-test")}"`,
    );
    expect(familyGlyphMarkup(withBody('<path d="M1 1"/>'))).not.toContain(
      "famgap-",
    );
  });
});

describe("defineIconFamily — active form", () => {
  const f = defineIconFamily({
    id: "active-test",
    label: "Active test",
    coverage: "fallback",
    stroke: 1.6,
    glyphs: {
      pin: {
        body: '<path d="M1 1"/>',
        active: '<path fill="currentColor" d="M1 1z"/>',
      },
      x: { body: '<path d="M2 2"/>' },
    },
    symbols: { keep: "pin", close: "x" },
  });

  test("the sheet holds an active symbol only for a glyph that has an active form", () => {
    const markup = familyGlyphMarkup(f);
    expect(markup).toContain(
      `<symbol id="${familyGlyphId("active-test", "pin", true)}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path fill="currentColor" d="M1 1z"/></g></symbol>`,
    );
    expect(markup).not.toContain(familyGlyphId("active-test", "x", true));
  });

  test("an active part makes the glyph animated", () => {
    const g = defineIconFamily({
      id: "active-motion",
      label: "Active motion",
      coverage: "fallback",
      stroke: 1.6,
      glyphs: {
        x: {
          body: '<path d="M1 1"/>',
          active: '<path data-motion="pop" d="M1 1"/>',
        },
      },
      symbols: { close: "x" },
    });
    expect(g.glyphs.x.animated).toBe(true);
  });
});
