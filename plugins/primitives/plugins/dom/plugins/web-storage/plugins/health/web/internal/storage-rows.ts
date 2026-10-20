import type {
  AreaScan,
  StoreUsage,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

/** One line of the Browser storage detail: an owner, or keys no loaded owner holds. */
export interface StorageRow {
  id: string;
  label: string;
  area: "local" | "session";
  kind: "owner" | "legacy" | "unowned";
  /** `null`: declared, not touched in this page and not found by the scan. */
  bytes: number | null;
  keys: number | null;
  cap: number | null;
  policy: "evict-oldest" | "refuse" | null;
  evicted: number;
  refused: number;
  /** For `unowned`: its biggest keys, the likely culprit. */
  note: string | null;
}

/**
 * The owners' live counters, completed by one area scan: an owner this page
 * has not touched yet takes its footprint from the scan (its keys exist all the
 * same), and keys no declared owner holds become Legacy / Unowned rows.
 */
export function storageRows(
  usage: StoreUsage[],
  scans: AreaScan[],
): StorageRow[] {
  const rows: StorageRow[] = [];
  const scanned = new Map<string, { bytes: number; keys: number }>();
  for (const scan of scans) {
    if (scan.kind !== "ok") continue;
    for (const b of scan.buckets) {
      if (b.kind === "owner") {
        scanned.set(`${scan.area}:${b.id}`, b);
        continue;
      }
      rows.push({
        id: `${scan.area}:${b.id}`,
        label:
          b.kind === "unowned"
            ? "Unowned keys"
            : `Legacy keys of ${b.id.slice("legacy:".length)}`,
        area: scan.area,
        kind: b.kind,
        bytes: b.bytes,
        keys: b.keys,
        cap: null,
        policy: null,
        evicted: 0,
        refused: 0,
        note:
          b.largest.length > 0
            ? `Largest: ${b.largest.map((l) => l.key).join(", ")}`
            : b.kind === "legacy"
              ? "Deleted the first time this page uses its owner"
              : null,
      });
    }
  }
  const declared = new Set<string>();
  for (const u of usage) {
    const key = `${u.area}:${u.owner}`;
    declared.add(key);
    const fromScan = scanned.get(key);
    rows.push({
      id: key,
      label: u.label,
      area: u.area,
      kind: "owner",
      bytes: u.bytes ?? fromScan?.bytes ?? null,
      keys: u.entries ?? fromScan?.keys ?? null,
      cap: u.cap,
      policy: u.whenFull,
      evicted: u.evicted,
      refused: u.refusedOverCap + u.refusedByBrowser,
      note: null,
    });
  }
  // Keys under `s:<owner>:` whose owner's plugin has not loaded in this page.
  for (const [key, b] of scanned) {
    if (declared.has(key)) continue;
    const [area, owner] = key.split(":") as ["local" | "session", string];
    rows.push({
      id: key,
      label: owner,
      area,
      kind: "owner",
      bytes: b.bytes,
      keys: b.keys,
      cap: null,
      policy: null,
      evicted: 0,
      refused: 0,
      note: "Its plugin has not loaded in this page",
    });
  }
  return rows;
}
