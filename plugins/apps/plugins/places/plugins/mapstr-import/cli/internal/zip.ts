import { inflateRawSync } from "node:zlib";

// A minimal zip reader — enough for a Mapstr export (two deflated files). The
// repo has no zip dependency and this needs ~50 lines of the format, so it reads
// the central directory itself rather than adding one. Zip64, encryption and
// multi-disk archives are refused loudly, never half-read.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** Every file in the archive, by its path inside it (directories skipped). */
export function readZipEntries(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (count === 0xffff || at === 0xffffffff) {
    throw new Error("zip64 archives are not supported");
  }

  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt zip: no central header at ${at}`);
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;
    if (flags & 0x1) throw new Error(`zip entry ${name} is encrypted`);
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error(`corrupt zip: no local header for ${name}`);
    }
    const dataStart =
      localOffset +
      30 +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    const data = zip.subarray(dataStart, dataStart + compressedSize);

    let bytes: Uint8Array;
    if (method === STORED) bytes = data;
    else if (method === DEFLATED) bytes = inflateRawSync(data);
    else throw new Error(`zip entry ${name}: unsupported method ${method}`);
    if (bytes.length !== size) {
      throw new Error(
        `zip entry ${name}: ${bytes.length} bytes, header says ${size}`,
      );
    }
    out.set(name, bytes);
  }
  return out;
}

/** The End Of Central Directory record sits in the last 22 + 65535 bytes. */
function findEndOfCentralDirectory(view: DataView): number {
  const floor = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let at = view.byteLength - 22; at >= floor; at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  throw new Error("not a zip archive (no end-of-central-directory record)");
}
