// ── A host's starting snapshot: its whole state, as one file ────────────────
//
// What a browser host can start from instead of an empty storage: the
// database's data directory (PGlite's `dumpDataDir`, a gzipped tar) and every
// host store's entries, taken from a host that already ran (a demo's seed, run
// once by the build — `../../cli`'s `takeHostSnapshot`). Times inside it are
// as they were at `takenAt`; whoever loads it shifts them to now (the
// database by its driver, each store by its owner's `shiftTime`).
//
// The file: `[u32 LE header length][header JSON][payloads…]`. The header holds
// the snapshot's facts and every store value as JSON, a binary value (a
// `Uint8Array`, a `Blob`) replaced by `{ "$hostSnapshotPayload": <index> }`
// pointing at one payload range. Plain data only — a value of any other kind
// is refused when the snapshot is taken, not discovered when it is loaded.

/** A host's whole state at one instant. */
export interface HostSnapshot {
  /** When it was taken (epoch ms): what its times are relative to. */
  takenAt: number;
  /** The migration hashes its database has applied. */
  migrations: string[];
  /** PGlite's data directory (`dumpDataDir("gzip")`). */
  database: Blob;
  /** Every host store's entries, by store name. */
  stores: Record<string, Array<[key: string, value: unknown]>>;
}

/**
 * Where a host finds the snapshot it ships, and which one it is: what the
 * build generates beside the worker (`@browser-host-snapshot/<host>`).
 */
export interface HostSnapshotRef {
  /** The hash of the file's bytes: two snapshots are the same iff it is. */
  version: string;
  /** When it was taken (epoch ms): a later one is newer. */
  takenAt: number;
  /** The file's bytes (fetched from beside the module the build generated); throws when it cannot. */
  load(): Promise<Uint8Array>;
}

const PAYLOAD = "$hostSnapshotPayload";
const FORMAT = 1;

interface Header {
  format: number;
  takenAt: number;
  migrations: string[];
  database: number;
  stores: Record<string, Array<[string, unknown]>>;
  payloads: Array<{
    kind: "bytes" | "blob";
    type: string;
    offset: number;
    length: number;
  }>;
}

/** The snapshot as one file. Throws on a store value that is not plain data. */
export async function encodeHostSnapshot(
  snapshot: HostSnapshot,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const payloads: Header["payloads"] = [];
  let offset = 0;
  const add = (
    bytes: Uint8Array,
    kind: "bytes" | "blob",
    type: string,
  ): number => {
    parts.push(bytes);
    payloads.push({ kind, type, offset, length: bytes.byteLength });
    offset += bytes.byteLength;
    return payloads.length - 1;
  };
  const encode = async (value: unknown, path: string): Promise<unknown> => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value;
    if (value instanceof Uint8Array)
      return { [PAYLOAD]: add(value, "bytes", "") };
    if (value instanceof Blob)
      return {
        [PAYLOAD]: add(
          new Uint8Array(await value.arrayBuffer()),
          "blob",
          value.type,
        ),
      };
    if (Array.isArray(value))
      return Promise.all(value.map((v, i) => encode(v, `${path}[${i}]`)));
    if (
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      if (PAYLOAD in value)
        throw new Error(
          `[host-snapshot] ${path} holds the reserved key "${PAYLOAD}"`,
        );
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value))
        if (v !== undefined) out[k] = await encode(v, `${path}.${k}`);
      return out;
    }
    throw new Error(
      `[host-snapshot] ${path} is not plain data (${Object.prototype.toString.call(value)}): a store value must be JSON, a Uint8Array or a Blob`,
    );
  };
  const database = add(
    new Uint8Array(await snapshot.database.arrayBuffer()),
    "blob",
    snapshot.database.type,
  );
  const stores: Header["stores"] = {};
  for (const [name, entries] of Object.entries(snapshot.stores)) {
    stores[name] = [];
    for (const [key, value] of entries)
      stores[name].push([key, await encode(value, `${name}[${key}]`)]);
  }
  const header: Header = {
    format: FORMAT,
    takenAt: snapshot.takenAt,
    migrations: snapshot.migrations,
    database,
    stores,
    payloads,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + headerBytes.byteLength + offset);
  new DataView(out.buffer).setUint32(0, headerBytes.byteLength, true);
  out.set(headerBytes, 4);
  let at = 4 + headerBytes.byteLength;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** The snapshot a file holds. Throws on a file of another format. */
export function decodeHostSnapshot(file: Uint8Array): HostSnapshot {
  const headerLength = new DataView(
    file.buffer,
    file.byteOffset,
    file.byteLength,
  ).getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(file.subarray(4, 4 + headerLength)),
  ) as Header;
  if (header.format !== FORMAT)
    throw new Error(
      `[host-snapshot] a snapshot of format ${String(header.format)}, this code reads ${FORMAT}`,
    );
  const base = 4 + headerLength;
  const payload = (index: number): Uint8Array | Blob => {
    const p = header.payloads[index];
    if (p === undefined)
      throw new Error(`[host-snapshot] no payload #${index}`);
    // A copy: the value outlives the file's buffer.
    const bytes = file.slice(base + p.offset, base + p.offset + p.length);
    return p.kind === "bytes" ? bytes : new Blob([bytes], { type: p.type });
  };
  const decode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decode);
    if (value !== null && typeof value === "object") {
      if (PAYLOAD in value)
        return payload((value as Record<string, number>)[PAYLOAD]!);
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, decode(v)]),
      );
    }
    return value;
  };
  const database = payload(header.database);
  if (!(database instanceof Blob))
    throw new Error("[host-snapshot] the database payload is not a blob");
  return {
    takenAt: header.takenAt,
    migrations: header.migrations,
    database,
    stores: Object.fromEntries(
      Object.entries(header.stores).map(([name, entries]) => [
        name,
        entries.map(([k, v]): [string, unknown] => [k, decode(v)]),
      ]),
    ),
  };
}
