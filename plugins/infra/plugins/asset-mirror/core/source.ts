/**
 * A mirror's source: where its files come from and the sha256 of each one.
 *
 * The file set is CLOSED and every file is pinned — the mirror serves a name
 * only if it is listed here, and only the bytes whose digest matches. So a
 * remote file replaced under the same name, or a download that came back
 * corrupted, is refused (502) rather than cached and served as immutable, and
 * every machine serves the same bytes. Pins are written by
 * `scripts/pin.ts`; moving one is a reviewed diff, like any `infra/deps`
 * `download(...)` pin.
 *
 * Plain data, shared by the mirror's registration (`defineAssetMirror`,
 * server), its prewarm descriptor (`defineAssetMirrorPrewarm`) and the
 * release runner, which reads it without booting a server.
 */
export interface AssetMirrorSource<F extends string = string> {
  /** Stable id; the URL segment `/api/asset-mirror/<id>/…`. Must match the id
   *  the web consumer passes to `assetMirrorBase` / `assetMirrorFile`. */
  readonly id: string;
  /** Remote base URL (no trailing `/`). A file is fetched as
   *  `<remoteBaseUrl>/<encoded name>`. */
  readonly remoteBaseUrl: string;
  /** Every file the mirror serves → its lowercase hex sha256. A name is flat,
   *  or one directory deep (`en/data.json`). */
  readonly files: Readonly<Record<F, string>>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isFlatSegment(s: string): boolean {
  return (
    s.length > 0 && !s.includes("/") && !s.includes("\\") && !s.includes("..")
  );
}

/**
 * Declare a mirror's source. Throws at module eval on a malformed pin or name,
 * so a typo never reaches a request.
 */
export function defineAssetMirrorSource<const F extends string>(spec: {
  id: string;
  remoteBaseUrl: string;
  files: Readonly<Record<F, string>>;
}): AssetMirrorSource<F> {
  if (!isFlatSegment(spec.id)) {
    throw new Error(`[asset-mirror] invalid mirror id "${spec.id}"`);
  }
  const names = Object.keys(spec.files) as F[];
  if (names.length === 0) {
    throw new Error(
      `[asset-mirror:${spec.id}] a mirror pins at least one file`,
    );
  }
  for (const name of names) {
    const segments = name.split("/");
    if (segments.length > 2 || !segments.every(isFlatSegment)) {
      throw new Error(
        `[asset-mirror:${spec.id}] "${name}" is not a flat name or one directory deep`,
      );
    }
    if (!SHA256_HEX.test(spec.files[name])) {
      throw new Error(
        `[asset-mirror:${spec.id}] "${name}" pins "${spec.files[name]}", not a lowercase hex sha256`,
      );
    }
  }
  return {
    id: spec.id,
    remoteBaseUrl: spec.remoteBaseUrl.replace(/\/$/, ""),
    files: spec.files,
  };
}

/** The pinned digest of `name`, or `undefined` when the mirror does not serve it. */
export function pinOf(
  source: AssetMirrorSource,
  name: string,
): string | undefined {
  return Object.hasOwn(source.files, name)
    ? (source.files as Record<string, string>)[name]
    : undefined;
}

/** A download whose bytes are not the pinned ones. */
export class AssetPinMismatchError extends Error {
  constructor(
    readonly url: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `${url} downloaded with sha256 ${actual}, expected the pinned ${expected}`,
    );
    this.name = "AssetPinMismatchError";
  }
}

/** Lowercase hex sha256 of `bytes` — the host's native digest (Web Crypto, on Bun and in a browser). */
export async function sha256OfBytes(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The remote URL of one file: `<remoteBaseUrl>/<name>`, each segment encoded (`PP C#1.ogg` → `PP%20C%231.ogg`). */
export function remoteFileUrl(source: AssetMirrorSource, name: string): string {
  return `${source.remoteBaseUrl}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Check downloaded bytes against their pin — the one check behind both the
 * lazy cache miss (`server/`) and the release prewarm (`bundle`), each of
 * which fetches {@link remoteFileUrl} itself. Resolves only when the bytes
 * hash to the pin; throws on an unpinned name or a mismatch
 * ({@link AssetPinMismatchError}), and the caller writes nothing then.
 */
export async function verifyPinnedBytes(
  source: AssetMirrorSource,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const expected = pinOf(source, name);
  if (expected === undefined) {
    throw new Error(`[asset-mirror:${source.id}] "${name}" is not pinned`);
  }
  const actual = await sha256OfBytes(bytes);
  if (actual !== expected) {
    throw new AssetPinMismatchError(
      remoteFileUrl(source, name),
      expected,
      actual,
    );
  }
}

/**
 * Where a pinned file lives in the cache, relative to its root: under its
 * digest, `<id>/<sha256>` — content-addressed, so a file is only ever read
 * back as the bytes it was verified to be, a re-pin is a new entry (never an
 * overwrite), and an entry cached before pins existed is never served.
 */
export function cachedFileSegments(
  source: AssetMirrorSource,
  sha256: string,
): readonly [string, string] {
  return [source.id, sha256];
}
