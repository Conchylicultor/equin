/**
 * Pure-parser tests for `parseComputedColor` — the DOM-free half of the CSS
 * color resolver. `resolveCssColor` needs a real browser
 * (probe element + getComputedStyle) and are exercised by the e2e flows, not
 * here; importing the module must NOT require a DOM, which this file also
 * implicitly verifies by running under plain `bun test`.
 */

import { expect, test } from "bun:test";
import { parseComputedColor } from "./css-color";

test("parses legacy rgb(r, g, b)", () => {
  expect(parseComputedColor("rgb(255, 0, 128)")).toBe(0xff0080);
  expect(parseComputedColor("rgb(0, 0, 0)")).toBe(0x000000);
  expect(parseComputedColor("rgb(255, 255, 255)")).toBe(0xffffff);
  // Whitespace tolerance + fractional channels (some engines emit floats).
  expect(parseComputedColor("  rgb( 12 , 34.5 , 56 )  ")).toBe((12 << 16) | (35 << 8) | 56);
});

test("parses rgba(r, g, b, a) and ignores alpha", () => {
  expect(parseComputedColor("rgba(255, 0, 128, 0.5)")).toBe(0xff0080);
  expect(parseComputedColor("rgba(10, 20, 30, 0)")).toBe((10 << 16) | (20 << 8) | 30);
});

test("parses color(srgb r g b) with 0..1 channels", () => {
  expect(parseComputedColor("color(srgb 1 0 0.5)")).toBe((255 << 16) | (0 << 8) | 128);
  expect(parseComputedColor("color(srgb 0 0 0)")).toBe(0x000000);
  expect(parseComputedColor("color(srgb 1 1 1)")).toBe(0xffffff);
});

test("parses color(srgb r g b / a) and ignores alpha", () => {
  expect(parseComputedColor("color(srgb 0.2 0.4 0.6 / 0.8)")).toBe(
    (Math.round(0.2 * 255) << 16) | (Math.round(0.4 * 255) << 8) | Math.round(0.6 * 255),
  );
});

test("clamps out-of-range channels instead of overflowing the packing", () => {
  expect(parseComputedColor("rgb(999, 0, 0)")).toBe(0xff0000);
  expect(parseComputedColor("color(srgb 1.2 0 0)")).toBe(0xff0000);
});

/** Unpack for per-channel tolerance assertions (conversion rounding). */
const channels = (packed: number) => [
  (packed >> 16) & 0xff,
  (packed >> 8) & 0xff,
  packed & 0xff,
];

const expectClose = (packed: number | null, expected: number, tol = 1) => {
  expect(packed).not.toBeNull();
  const got = channels(packed!);
  const want = channels(expected);
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(got[i]! - want[i]!)).toBeLessThanOrEqual(tol);
  }
};

// Per CSS Color 4, an oklch-AUTHORED color keeps its color space in the
// computed value — Chrome hands back `oklch(…)` for our theme tokens, so the
// parser must do the OKLab→sRGB conversion itself. Reference values from the
// OKLab definition (oklch(0.628 0.258 29.23) ≈ pure sRGB red, etc.).
test("parses computed oklch(L C H) via OKLab→sRGB conversion", () => {
  expectClose(parseComputedColor("oklch(0.6279554 0.2576833 29.2338851)"), 0xff0000);
  expectClose(parseComputedColor("oklch(0.8664396 0.2948272 142.4953389)"), 0x00ff00);
  expectClose(parseComputedColor("oklch(0.4520137 0.3132140 264.0520206)"), 0x0000ff);
  expectClose(parseComputedColor("oklch(1 0 0)"), 0xffffff);
  expectClose(parseComputedColor("oklch(0 0 0)"), 0x000000);
});

test("oklch tolerates %, deg, none, and an alpha tail", () => {
  expectClose(parseComputedColor("oklch(100% 0 0)"), 0xffffff);
  expectClose(parseComputedColor("oklch(0.6279554 0.2576833 29.2338851deg)"), 0xff0000);
  expectClose(parseComputedColor("oklch(1 0 none)"), 0xffffff);
  expectClose(parseComputedColor("oklch(0.6279554 0.2576833 29.2338851 / 0.5)"), 0xff0000);
});

test("out-of-gamut oklch clips per channel instead of overflowing", () => {
  // Chroma pushed beyond sRGB at red's hue: red overshoots 1 and green/blue
  // go negative pre-clip — every channel must clamp, never wrap the packing.
  expect(parseComputedColor("oklch(0.6 0.4 29.23)")).toBe(0xff0000);
});

test("parses computed oklab(L a b)", () => {
  expectClose(parseComputedColor("oklab(0.6279554 0.2248631 0.1258463)"), 0xff0000);
  expectClose(parseComputedColor("oklab(1 0 0)"), 0xffffff);
  expectClose(parseComputedColor("oklab(0.4520137 -0.0324554 -0.3115281)"), 0x0000ff);
});

test("returns null for anything that is not a known computed serialization", () => {
  expect(parseComputedColor("")).toBeNull();
  expect(parseComputedColor("garbage")).toBeNull();
  expect(parseComputedColor("#ff0080")).toBeNull(); // authored form, never computed
  expect(parseComputedColor("var(--primary)")).toBeNull(); // unresolved expression
  expect(parseComputedColor("hsl(120, 50%, 50%)")).toBeNull();
  expect(parseComputedColor("rgb(1, 2)")).toBeNull(); // malformed arity
  expect(parseComputedColor("color(display-p3 1 0 0)")).toBeNull(); // non-srgb space
  expect(parseComputedColor("oklch(0.7 0.1)")).toBeNull(); // malformed arity
  expect(parseComputedColor("lab(50 40 30)")).toBeNull(); // unhandled space stays loud
});
