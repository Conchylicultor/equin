import type { EndpointDef, MachineEndpointDef } from "./define-endpoint";
import type { MachineFeature } from "./needs-machine";
import { interpolatePath } from "./route-params";

declare const assetPathBrand: unique symbol;

/**
 * The key an {@link AssetPath}'s `/api/…` path is held under — not a `path`
 * field, so no element is one property away from a `src` that bypasses the
 * subtree's transport. Its one reader is `useAssetSrc` (`endpoints/web`); it
 * is on the core barrel only because the browser build loads `core/` as its
 * barrel artifact, so `web/` cannot reach the file directly. Never read it
 * elsewhere: an element gets its `src` from `useAssetSrc`.
 */
export const ASSET_PATH = Symbol("asset-path");

/**
 * The address of a server asset an element loads — an attachment's bytes, a
 * checkout image, a host file — as a GET endpoint of the subtree's server
 * serves it. Opaque on purpose: it is NOT a string, so it cannot be dropped
 * into an `<img src>`, an `href` or an `<iframe src>` as is. An element gets
 * its `src` from `useAssetSrc(asset)` (`endpoints/web`), which loads it over
 * the SUBTREE'S transport: the path itself where the transport's server is
 * reachable by URL (the page's own), a blob URL fetched through the transport
 * otherwise (an in-browser server, which no URL reaches), and `unavailable`
 * when the route needs the computer and none is behind the transport.
 *
 * Built only by {@link assetPath}, from the endpoint that serves it, so the
 * path cannot drift from the route and `needsMachine` comes from the route's
 * own declaration.
 */
export interface AssetPath {
  readonly [assetPathBrand]: true;
  /** The `/api/…` path (and query) the asset is served at, on its server. */
  readonly [ASSET_PATH]: string;
  /** The route's `needsMachine` — set when only the desktop app serves it. */
  readonly needsMachine: MachineFeature | null;
}

/** A GET endpoint — the only kind an element loads. */
type AssetEndpoint<TParams, TQuery> =
  | EndpointDef<`GET ${string}`, TParams, unknown, unknown, TQuery>
  | MachineEndpointDef<`GET ${string}`, TParams, unknown, unknown, TQuery>;

/**
 * The {@link AssetPath} of what `endpoint` serves for `params` (and `query`,
 * an absent or nullish member dropped — as `fetchEndpoint` sends it).
 */
export function assetPath<TParams, TQuery>(
  endpoint: AssetEndpoint<TParams, TQuery>,
  params: TParams,
  ...query: [TQuery] extends [void] ? [] : [query: TQuery]
): AssetPath {
  let path = interpolatePath(
    endpoint.path,
    (params ?? {}) as Record<string, string>,
  );
  const [q] = query;
  if (q != null) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(q as Record<string, unknown>)) {
      if (value !== undefined && value !== null) search.set(key, String(value));
    }
    const qs = search.toString();
    if (qs) path += `?${qs}`;
  }
  return {
    [ASSET_PATH]: path,
    needsMachine: endpoint.needsMachine ?? null,
  } as AssetPath;
}
