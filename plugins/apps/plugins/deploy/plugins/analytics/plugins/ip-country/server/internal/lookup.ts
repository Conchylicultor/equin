import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { ipCountryCache } from "../../data-dirs";
import { loadSnapshot, lookupIn, type Snapshot } from "./snapshot";

/**
 * Which country an IP address is in.
 *
 * - `found` — a country code (ISO 3166-1 alpha-2, as DB-IP spells it).
 * - `unlisted` — the data has no country for it: a private or reserved range
 *   (`ZZ`), an address in no range, or a string that is not an address.
 * - `unavailable` — no snapshot has been downloaded yet. A caller must handle
 *   this separately, so "we do not know yet" never passes as "no country".
 */
export type IpCountryResult =
  | { kind: "found"; country: string }
  | { kind: "unlisted" }
  | { kind: "unavailable" };

export interface IpCountryLookup {
  lookup(ip: string): IpCountryResult;
  /** Drop what is in memory; the next lookup reads the file again. */
  reload(): void;
}

type Held =
  | { kind: "unread" }
  | { kind: "missing" }
  | { kind: "loaded"; snapshot: Snapshot }
  | { kind: "broken"; error: unknown };

/**
 * A lookup over the snapshot file at `snapshotPath()`, read lazily on the first
 * lookup (one synchronous ~16 MB read) and then held in memory. A process that
 * never looks anything up never reads it.
 *
 * A snapshot that fails to load is remembered and its error rethrown on every
 * lookup until `reload()`, so a corrupt file fails loudly without being
 * re-read on each request.
 */
export function createIpCountryLookup(
  snapshotPath: () => AppPath,
): IpCountryLookup {
  let held: Held = { kind: "unread" };
  const read = (): Held => {
    const path = snapshotPath();
    if (!existsSync(path)) return { kind: "missing" };
    try {
      return { kind: "loaded", snapshot: loadSnapshot(readFileSync(path)) };
    } catch (error) {
      return { kind: "broken", error };
    }
  };
  return {
    lookup(ip) {
      if (held.kind === "unread") held = read();
      switch (held.kind) {
        case "missing":
          return { kind: "unavailable" };
        case "broken":
          throw held.error;
        case "loaded":
          return lookupIn(held.snapshot, ip);
        case "unread":
          throw new Error("ip-country: snapshot still unread after reading it");
      }
    },
    reload() {
      held = { kind: "unread" };
    },
  };
}

/** The snapshot file inside the machine-wide cache dir. */
export function defaultSnapshotPath(): AppPath {
  return ipCountryCache.file("ip-country.bin");
}

const defaultLookup = createIpCountryLookup(defaultSnapshotPath);

/** Which country `ip` is in, from this machine's downloaded DB-IP snapshot. */
export function lookupCountry(ip: string): IpCountryResult {
  return defaultLookup.lookup(ip);
}

/** Swap in a newly written snapshot. The refresh job calls it after its rename. */
export function reloadIpCountry(): void {
  defaultLookup.reload();
}
