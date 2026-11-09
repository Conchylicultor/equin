import {
  assetBase,
  assetPath,
  blob,
  defineEndpoint,
  type AssetBase,
  type AssetPath,
} from "@plugins/infra/plugins/endpoints/core";

/**
 * The mirror's routes, declared so every reader of them is judged (the
 * browser-host coverage guard reads a literal `route:`). Served on every host
 * by the portable `server/` half, over a data-files root (the disk on the
 * desktop, memory in a browser host). A mirrored path is a flat file name, or
 * one directory deep (`en/data.json`) for a consumer that lays its remote tree
 * out that way — the router has no splat, so each depth is its own route onto
 * the same handler.
 */
/** One mirrored file: `/api/asset-mirror/<id>/<file>`. */
export const getMirroredFile = defineEndpoint({
  route: "GET /api/asset-mirror/:id/:file",
  response: blob(),
});

/** One mirrored file one directory deep: `/api/asset-mirror/<id>/<dir>/<file>`. */
export const getMirroredNestedFile = defineEndpoint({
  route: "GET /api/asset-mirror/:id/:dir/:file",
  response: blob(),
});

/**
 * A registered mirror's files, for a library that fetches `<base>/<file>` (or
 * `<base>/<dir>/<file>`) itself — an emoji picker's data, a sampler's
 * samples. Resolve it with `assetFetchOver` (`endpoints/web`) for a library
 * that takes a fetch hook — it loads over the subtree's transport, so an
 * in-browser server answers it — or `useAssetUrl` for one that only takes a
 * URL; both routes share this prefix.
 */
export function assetMirrorBase(id: string): AssetBase {
  return assetBase(getMirroredFile, { id });
}

/**
 * One file of a registered mirror, for an element that loads it itself — a
 * `<video>`'s or `<img>`'s source, resolved with `useAssetSrc`
 * (`endpoints/web`): the path on a server reachable by URL, a blob URL from an
 * in-browser server.
 */
export function assetMirrorFile(id: string, file: string): AssetPath {
  return assetPath(getMirroredFile, { id, file });
}
