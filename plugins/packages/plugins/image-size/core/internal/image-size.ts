/** An image's natural size, in pixels. */
export interface ImageSize {
  width: number;
  height: number;
}

/**
 * What reading a header found: the size, or why there is none — a format this
 * reader does not know, or a header the given bytes stop short of (a JPEG's
 * frame header can sit after a large EXIF block).
 */
export type ImageSizeRead =
  | { kind: "size"; size: ImageSize }
  | { kind: "unknown-format" }
  | { kind: "truncated" };

/**
 * How many leading bytes almost every image's size is found in: PNG, GIF,
 * WebP and BMP within 30, a JPEG after its EXIF / ICC segments. A caller
 * holding a long buffer can hand over only this much, and the whole buffer on
 * `truncated`.
 */
export const IMAGE_SIZE_PREFIX_BYTES = 64 * 1024;

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) =>
  b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const i32le = (b: Uint8Array, i: number) =>
  b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24);
const ascii = (b: Uint8Array, i: number, s: string) =>
  [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

const size = (width: number, height: number): ImageSizeRead =>
  width > 0 && height > 0
    ? { kind: "size", size: { width, height } }
    : { kind: "unknown-format" };

/**
 * The pixel size an image's header declares, from its leading bytes. An EXIF
 * orientation is not applied: the size is the stored raster's, as `<img>`
 * reports it for a JPEG without one.
 */
export function readImageSize(bytes: Uint8Array): ImageSizeRead {
  const b = bytes;
  // PNG: signature, then IHDR's width and height.
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, "PNG")) {
    if (b.length < 24) return { kind: "truncated" };
    return size(u32be(b, 16), u32be(b, 20));
  }
  // GIF: logical screen size.
  if (ascii(b, 0, "GIF8")) {
    if (b.length < 10) return { kind: "truncated" };
    return size(u16le(b, 6), u16le(b, 8));
  }
  // BMP: BITMAPINFOHEADER (a negative height is a top-down bitmap).
  if (ascii(b, 0, "BM") && b.length >= 14) {
    if (b.length < 26) return { kind: "truncated" };
    return size(Math.abs(i32le(b, 18)), Math.abs(i32le(b, 22)));
  }
  // WebP: RIFF container, one of three chunk kinds.
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) {
    if (b.length < 30) return { kind: "truncated" };
    if (ascii(b, 12, "VP8X")) return size(u24le(b, 24) + 1, u24le(b, 27) + 1);
    if (ascii(b, 12, "VP8L")) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (ascii(b, 12, "VP8 ")) {
      return size(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    }
    return { kind: "unknown-format" };
  }
  // JPEG: walk the segments to the first start-of-frame.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return { kind: "unknown-format" };
      const marker = b[i + 1]!;
      // Fill bytes before a marker.
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      // Standalone markers carry no length.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const isFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isFrame) {
        if (i + 9 > b.length) return { kind: "truncated" };
        return size(u16be(b, i + 7), u16be(b, i + 5));
      }
      i += 2 + u16be(b, i + 2);
    }
    return { kind: "truncated" };
  }
  return { kind: "unknown-format" };
}
