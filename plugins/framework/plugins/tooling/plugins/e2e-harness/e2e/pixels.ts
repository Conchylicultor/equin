/**
 * Reading pixels back off the page — the assertion of last resort, for claims
 * about what the user actually SEES.
 *
 * Some UI claims are not expressible in the DOM. A gradient painted by a
 * pseudo-element has no rect to query, no text to match and no attribute to
 * read; `getComputedStyle(el, "::before")` reports the opacity it was *given*,
 * which stays `1` whether the strip lands over the content or half a panel away.
 * That exact gap shipped a scroll fade whose top strip was fully opaque and
 * positioned outside the visible box: every DOM-level check passed, and only a
 * screenshot caught it.
 *
 * So: screenshot the region, hand the PNG back into the page as a data URL, and
 * let the browser decode it onto a canvas. No image dependency, no format
 * parsing here — Chromium already owns a PNG decoder.
 *
 * Cost is real (the pixels cross the bridge as base64), so sample the BAND you
 * are asserting about, not the whole page.
 */
import type { Page } from "playwright";
import type { Rgba } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelGrid {
  /** Sampled size in CSS pixels (device pixel ratio is normalized away). */
  width: number;
  height: number;
  /** Colour at a point, in coordinates relative to the sampled rect. */
  at(x: number, y: number): Rgba;
}

/** Max per-channel difference — 0 is identical, 255 is black vs white. */
export function colorDistance(a: Rgba, b: Rgba): number {
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
  );
}

/**
 * Sample the composited colours inside `rect` (viewport coordinates — what
 * `locator.boundingBox()` returns).
 *
 * Throws rather than returning an empty grid if the capture or decode fails: a
 * pixel assertion that silently reads nothing would pass every "is it covered?"
 * check by default.
 */
export async function samplePixels(page: Page, rect: Rect): Promise<PixelGrid> {
  const clip = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
  const png = (await page.screenshot({ clip })).toString("base64");
  const decoded = await page.evaluate(async (png: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("samplePixels: no 2d context");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    // Base64 of the raw RGBA bytes: a plain number[] would cross the bridge as
    // JSON, ~10x the size for the same pixels.
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < data.length; i += CHUNK)
      bin += String.fromCharCode(...data.subarray(i, i + CHUNK));
    return { b64: btoa(bin), width: img.width, height: img.height };
  }, png);

  const bytes = Buffer.from(decoded.b64, "base64");
  if (bytes.length !== decoded.width * decoded.height * 4)
    throw new Error(
      `samplePixels: decoded ${bytes.length} bytes for ${decoded.width}×${decoded.height}`,
    );
  // A HiDPI capture is larger than the CSS rect it was taken from; report CSS
  // pixels so callers can compare against layout numbers without a scale factor.
  const scale = decoded.width / clip.width;
  return {
    width: clip.width,
    height: clip.height,
    at(x: number, y: number): Rgba {
      const px = Math.min(
        decoded.width - 1,
        Math.max(0, Math.round(x * scale)),
      );
      const py = Math.min(
        decoded.height - 1,
        Math.max(0, Math.round(y * scale)),
      );
      const i = (decoded.width * py + px) * 4;
      return {
        r: bytes[i]!,
        g: bytes[i + 1]!,
        b: bytes[i + 2]!,
        a: bytes[i + 3]!,
      };
    },
  };
}

/**
 * CIE76 ΔE between two sRGB colours (0–255 channels; alpha ignored — composite
 * first if it matters): ~2 is just noticeable, 5 a visible drift. The same
 * arithmetic `colorReport` runs inside the page, where it cannot import this
 * (a `page.evaluate` body is serialized, so it carries its own copy).
 */
export function deltaE(a: Rgba, b: Rgba): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const f = (t: number): number =>
    t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const lab = (c: Rgba): [number, number, number] => {
    const R = lin(c.r);
    const G = lin(c.g);
    const B = lin(c.b);
    const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const p = lab(a);
  const q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
