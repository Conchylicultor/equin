import { entryBytes, KEY_ROOT, type StorageArea } from "../../core";
import { legacyOwnerOf, openArea } from "./store";

/** One group of an area's keys, by who holds them. */
export interface AreaBucket {
  /** An owner id; `legacy:<owner>` for keys an owner will delete on first use; `unowned`. */
  id: string;
  kind: "owner" | "legacy" | "unowned";
  bytes: number;
  keys: number;
  /** For `unowned`: the largest keys, so the culprit is named. */
  largest: { key: string; bytes: number }[];
}

export type AreaScan =
  | { kind: "ok"; area: StorageArea; total: number; buckets: AreaBucket[] }
  | { kind: "unavailable"; area: StorageArea };

const LARGEST = 5;

/**
 * Every key of an area grouped by holder — the health row's detail. A full
 * scan, so it runs only while the detail is open, never per write. A key
 * under `s:<owner>:` is that owner's even when the owner's plugin has not
 * loaded in this page yet.
 */
export function scanArea(area: StorageArea): AreaScan {
  const store = openArea(area);
  if (!store) return { kind: "unavailable", area };
  const buckets = new Map<string, AreaBucket>();
  let total = 0;
  const bucket = (id: string, kind: AreaBucket["kind"]): AreaBucket => {
    let b = buckets.get(id);
    if (!b) buckets.set(id, (b = { id, kind, bytes: 0, keys: 0, largest: [] }));
    return b;
  };
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key === null) continue;
      const bytes = entryBytes(key, store.getItem(key) ?? "");
      total += bytes;
      let b: AreaBucket;
      const legacy = legacyOwnerOf(key);
      if (key.startsWith(KEY_ROOT) && key.indexOf(":", KEY_ROOT.length) > 0) {
        b = bucket(
          key.slice(KEY_ROOT.length, key.indexOf(":", KEY_ROOT.length)),
          "owner",
        );
      } else if (legacy !== null) {
        b = bucket(`legacy:${legacy}`, "legacy");
      } else {
        b = bucket("unowned", "unowned");
        b.largest.push({ key, bytes });
        b.largest.sort((x, y) => y.bytes - x.bytes);
        b.largest.length = Math.min(b.largest.length, LARGEST);
      }
      b.bytes += bytes;
      b.keys++;
    }
  } catch (err) {
    if (err instanceof DOMException) return { kind: "unavailable", area };
    throw err;
  }
  return { kind: "ok", area, total, buckets: [...buckets.values()] };
}
