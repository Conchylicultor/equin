/**
 * PNG `tEXt` chunks, written and recognised in plain JS: how a rendered logo PNG
 * carries the digest of the SVG it came from, so a check can tell a stale one
 * without re-rasterizing (pixels differ across rasterizer versions; the digest
 * does not).
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function assertPng(png: Uint8Array): void {
  if (png.length < 33 || SIGNATURE.some((b, i) => png[i] !== b)) {
    throw new Error("Not a PNG: the 8-byte signature is missing.");
  }
}

/**
 * Whether `text` — a PNG read as text (the stamp is ASCII, so it survives a
 * lossy UTF-8 decode of the binary around it) — carries `key` = `value`.
 */
export function hasPngText(text: string, key: string, value: string): boolean {
  return text.includes(`tEXt${key}\u0000${value}`);
}

/** The PNG with one `tEXt` chunk added right after its IHDR (ASCII only). */
export function withPngText(
  png: Uint8Array,
  key: string,
  text: string,
): Uint8Array {
  assertPng(png);
  if (!/^[\x20-\x7e]{1,79}$/.test(key) || !/^[\x20-\x7e]*$/.test(text)) {
    throw new Error("A PNG text key and value must be printable ASCII.");
  }
  const enc = new TextEncoder();
  const data = new Uint8Array([...enc.encode(key), 0, ...enc.encode(text)]);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(enc.encode("tEXt"), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const ihdrEnd = 8 + 12 + 13;
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd));
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}
