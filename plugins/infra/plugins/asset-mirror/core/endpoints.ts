import {
  assetBase,
  blob,
  defineEndpoint,
  type AssetBase,
} from "@plugins/infra/plugins/endpoints/core";

/**
 * The mirror's routes, declared so every reader of them is judged: the
 * browser-host coverage guard reads a literal `route:`, and a client on a host
 * without the computer answers `unavailable` (the cache is on disk, so the
 * handler is the plugin's `machine/` half). A mirrored path is a flat file
 * name, or one directory deep (`en/data.json`) for a consumer that lays its
 * remote tree out that way — the router has no splat, so each depth is its
 * own route onto the same handler.
 */
const MIRROR_FEATURE = { feature: "The asset mirror" };

/** One mirrored file: `/api/asset-mirror/<id>/<file>`. */
export const getMirroredFile = defineEndpoint({
  route: "GET /api/asset-mirror/:id/:file",
  response: blob(),
  needsMachine: MIRROR_FEATURE,
});

/** One mirrored file one directory deep: `/api/asset-mirror/<id>/<dir>/<file>`. */
export const getMirroredNestedFile = defineEndpoint({
  route: "GET /api/asset-mirror/:id/:dir/:file",
  response: blob(),
  needsMachine: MIRROR_FEATURE,
});

/**
 * A registered mirror's files, for a library that fetches `<base>/<file>` (or
 * `<base>/<dir>/<file>`) itself — an emoji picker's data, a sampler's
 * samples. Resolve it with `useAssetUrl` (`endpoints/web`), which answers
 * `unavailable` on a host without the computer; both routes share this prefix.
 */
export function assetMirrorBase(id: string): AssetBase {
  return assetBase(getMirroredFile, { id });
}
