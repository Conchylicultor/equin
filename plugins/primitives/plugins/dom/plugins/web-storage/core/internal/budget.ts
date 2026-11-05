/**
 * The one budget every web-storage owner shares, as plain data both the
 * browser (the runtime assert in `defineStore`) and the `budget-fits` check
 * (which sees every owner, loaded or not) read.
 */

/** Which Web Storage area an owner's entries live in. */
export type StorageArea = "local" | "session";

/** An owner's byte cap, spelled so a reader (and the budget check) can parse it. */
export type StorageSize = `${number} KB` | `${number} MB`;

const UNIT = { KB: 1024, MB: 1024 * 1024 } as const;

/** Bytes in a `StorageSize`; throws on a malformed spelling. */
export function parseStorageSize(size: string): number {
  const m = /^(\d+(?:\.\d+)?) (KB|MB)$/.exec(size);
  if (!m)
    throw new Error(
      `web-storage: malformed size "${size}" (want "<n> KB" or "<n> MB")`,
    );
  return Math.round(Number(m[1]) * UNIT[m[2] as keyof typeof UNIT]);
}

/**
 * The sum of every owner's cap per area. Chrome gives an origin ~10 MB of
 * localStorage and the same per tab of sessionStorage (UTF-16, so 5 M
 * characters), and neither can be raised. Keeping the owners' caps under these
 * leaves headroom for keys no owner holds (a third-party library, leftovers),
 * so no owner can ever be refused by the browser because another one grew.
 */
export const AREA_BUDGET: Record<StorageArea, StorageSize> = {
  local: "7 MB",
  session: "4 MB",
};

/** What Chrome actually allows per area — the denominator the health row shows. */
export const AREA_QUOTA: Record<StorageArea, StorageSize> = {
  local: "10 MB",
  session: "10 MB",
};

/** An owner id: lowercase dotted/dashed words. No `:`, so no prefix contains another. */
export const OWNER_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * Every key the primitive writes starts with this, then `<owner>:` — or, for
 * an entry written inside a `PluginScope`, `<owner>@<scope>:`.
 */
export const KEY_ROOT = "s:";

/** Between an owner and the scope its entry was written in. Outside `OWNER_PATTERN`, so unambiguous. */
export const SCOPE_SEPARATOR = "@";

/**
 * A scope id: a `PluginScope`'s composition id, the same grammar as an owner
 * (no `:` and no `@`), so a key parses one way only.
 */
export const SCOPE_PATTERN = OWNER_PATTERN;

/**
 * The prefix of an owner's keys in one scope: `s:<owner>:` for the page's own
 * deploy (`scope` null — the keys every entry had before scopes, so nothing
 * stored moves), `s:<owner>@<scope>:` inside a `PluginScope`.
 */
export function ownerPrefix(
  owner: string,
  scope: string | null = null,
): string {
  return scope === null
    ? `${KEY_ROOT}${owner}:`
    : `${KEY_ROOT}${owner}${SCOPE_SEPARATOR}${scope}:`;
}

/** A primitive key, read back: whose it is, in which scope (`null`: the page's own), and its id. */
export interface StoreKey {
  owner: string;
  scope: string | null;
  id: string;
}

/** The one parser of the key grammar; `null` for a key the primitive did not write. */
export function parseStoreKey(key: string): StoreKey | null {
  if (!key.startsWith(KEY_ROOT)) return null;
  const sep = key.indexOf(":", KEY_ROOT.length);
  if (sep < 0) return null;
  const head = key.slice(KEY_ROOT.length, sep);
  const at = head.indexOf(SCOPE_SEPARATOR);
  const owner = at < 0 ? head : head.slice(0, at);
  const scope = at < 0 ? null : head.slice(at + 1);
  if (!OWNER_PATTERN.test(owner)) return null;
  if (scope !== null && !SCOPE_PATTERN.test(scope)) return null;
  return { owner, scope, id: key.slice(sep + 1) };
}

/** Bytes one entry costs: Web Storage counts UTF-16 code units of key + value. */
export function entryBytes(key: string, raw: string): number {
  return 2 * (key.length + raw.length);
}
