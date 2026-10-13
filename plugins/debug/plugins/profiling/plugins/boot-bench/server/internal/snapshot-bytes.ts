import { gzipSync } from "node:zlib";
import { LIVE_ROW_KEY } from "@plugins/network/plugins/live/core";
import type { SnapshotBytes } from "../../shared/endpoints";

/** What `assembleBootSnapshot` hands back — the boot-snapshot endpoint's body. */
interface AssembledSnapshot {
  resources: Record<string, unknown>;
  tuples: Record<string, { params: Record<string, string>; value: unknown }[]>;
}

// gzip at level 6 — what `gzip -6` (and the usual HTTP compressor default)
// produces, so a measurement here compares with one taken by hand on a curl.
function sizeOf(json: string): { raw: number; gzip: number } {
  const buf = Buffer.from(json, "utf8");
  return { raw: buf.byteLength, gzip: gzipSync(buf, { level: 6 }).byteLength };
}

// The rows a key's value holds: a window's array, or every enumerated tuple's.
function rowsOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The boot snapshot's size, as the endpoint serializes it: the whole body
 * (`total`), each key's own value (`perKey` — a default tuple's value, or an
 * enumerated key's `{ params, value }[]`), and, for each key whose rows carry
 * the server-minted row key, the mean bytes that member (`,"$key":…`) adds to
 * one row (`rowKeyBytes`) — times a deployment's row count, what a row key
 * costs that key there. A key none of whose rows carries one is absent.
 */
export function measureSnapshotBytes(snap: AssembledSnapshot): SnapshotBytes {
  const perKey: SnapshotBytes["perKey"] = {};
  const rowKeyBytes: SnapshotBytes["rowKeyBytes"] = {};
  const entries: [string, unknown, unknown[]][] = [
    ...Object.entries(snap.resources).map(
      ([k, v]): [string, unknown, unknown[]] => [k, v, rowsOf(v)],
    ),
    ...Object.entries(snap.tuples).map(
      ([k, ts]): [string, unknown, unknown[]] => [
        k,
        ts,
        ts.flatMap((t) => rowsOf(t.value)),
      ],
    ),
  ];
  for (const [key, value, rows] of entries) {
    perKey[key] = sizeOf(JSON.stringify(value));
    let keyed = 0;
    let bytes = 0;
    for (const row of rows) {
      if (row === null || typeof row !== "object" || !(LIVE_ROW_KEY in row)) {
        continue;
      }
      const member = (row as Record<string, unknown>)[LIVE_ROW_KEY];
      keyed++;
      // `,"$key":<json>` — the member plus the comma separating it.
      bytes += Buffer.byteLength(
        `,${JSON.stringify(LIVE_ROW_KEY)}:${JSON.stringify(member)}`,
        "utf8",
      );
    }
    if (keyed > 0) rowKeyBytes[key] = bytes / keyed;
  }
  return { total: sizeOf(JSON.stringify(snap)), perKey, rowKeyBytes };
}
