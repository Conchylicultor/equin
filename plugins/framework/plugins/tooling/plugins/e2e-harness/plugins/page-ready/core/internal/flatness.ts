/**
 * Did the page paint? — a capture of one flat colour is a page that never
 * rendered. Shared by the e2e harness (`snap`, `screenshot.ts`) and the agent
 * browser's host (`capturePair`), so both refuse the same "black screenshot".
 */
import type { Page } from "playwright";

/** One pixel's channels, 0–255. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A capture's verdict: one flat colour (and which), or real content. */
export type Flatness = { flat: true; color: Rgba } | { flat: false };

/**
 * Is this capture ONE flat colour — a page that never painted?
 *
 * A screenshot of an app that has not rendered yet (still booting on a loaded
 * machine, a dead chunk, a crashed root) is the document's bare background:
 * every pixel the same. It decodes, it is a valid PNG, and `snap()` used to
 * print `wrote …` for it — so agents took the black rectangle for evidence and
 * reasoned from it. No real screen is a single colour, so "flat" is a cheap,
 * app-agnostic proof that nothing was drawn.
 *
 * `tolerance` is the per-channel distance (see `colorDistance`) still counted as
 * the same colour, so dithering or a 1-step gradient band does not count as
 * content. Decoded in the page, like `samplePixels`; only the verdict crosses
 * the bridge.
 */
export async function flatness(
  page: Page,
  png: Buffer,
  tolerance = 4,
): Promise<Flatness> {
  return page.evaluate(
    async ({ b64, tolerance }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("flatness: no 2d context");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height).data;
      const r = d[0]!,
        g = d[1]!,
        b = d[2]!,
        a = d[3]!;
      for (let i = 4; i < d.length; i += 4) {
        if (
          Math.abs(d[i]! - r) > tolerance ||
          Math.abs(d[i + 1]! - g) > tolerance ||
          Math.abs(d[i + 2]! - b) > tolerance
        )
          return { flat: false as const };
      }
      return { flat: true as const, color: { r, g, b, a } };
    },
    { b64: png.toString("base64"), tolerance },
  );
}

/** `#rrggbb`, for a log line. */
export function hexColor(c: Rgba): string {
  return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
