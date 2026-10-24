import { describe, expect, test } from "bun:test";
import { readImageSize } from "./image-size";

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(
    parts.flatMap((p) =>
      typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p,
    ),
  );

describe("readImageSize", () => {
  test("PNG", () => {
    const png = bytes(
      [0x89],
      "PNG\r\n\x1a\n",
      [0, 0, 0, 13],
      "IHDR",
      [0, 0, 0x05, 0x78], // 1400
      [0, 0, 0x03, 0x84], // 900
    );
    expect(readImageSize(png)).toEqual({
      kind: "size",
      size: { width: 1400, height: 900 },
    });
    expect(readImageSize(png.slice(0, 12))).toEqual({ kind: "truncated" });
  });

  test("GIF", () => {
    expect(readImageSize(bytes("GIF89a", [10, 0, 20, 0]))).toEqual({
      kind: "size",
      size: { width: 10, height: 20 },
    });
  });

  test("JPEG walks past APP segments to the frame", () => {
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe0, 0, 6, 1, 2, 3, 4], // APP0, 4 bytes of payload
      [0xff, 0xc0, 0, 17, 8],
      [0x02, 0x58], // height 600
      [0x03, 0x20], // width 800
    );
    expect(readImageSize(jpeg)).toEqual({
      kind: "size",
      size: { width: 800, height: 600 },
    });
    expect(readImageSize(jpeg.slice(0, 10))).toEqual({ kind: "truncated" });
  });

  test("WebP VP8X", () => {
    const webp = bytes(
      "RIFF",
      [0, 0, 0, 0],
      "WEBP",
      "VP8X",
      [10, 0, 0, 0, 0, 0, 0, 0],
      [0x1f, 0x03, 0], // width - 1 = 799
      [0x57, 0x02, 0], // height - 1 = 599
    );
    expect(readImageSize(webp)).toEqual({
      kind: "size",
      size: { width: 800, height: 600 },
    });
  });

  test("an unknown format", () => {
    expect(readImageSize(bytes("<svg"))).toEqual({ kind: "unknown-format" });
  });
});
