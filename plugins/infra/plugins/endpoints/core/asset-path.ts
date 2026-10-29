import type { EndpointDef, MachineEndpointDef } from "./define-endpoint";
import type { MachineFeature } from "./needs-machine";
import { interpolatePath } from "./route-params";

declare const assetPathBrand: unique symbol;
declare const assetBaseBrand: unique symbol;

/**
 * The key an {@link AssetPath}'s `/api/…` path is held under — not a `path`
 * field, so no element is one property away from a `src` that bypasses the
 * subtree's transport. Its readers are `useAssetSrc` and `useAssetUrl`
 * (`endpoints/web`); it
 * is on the core barrel only because the browser build loads `core/` as its
 * barrel artifact, so `web/` cannot reach the file directly. Never read it
 * elsewhere: an element gets its `src` from `useAssetSrc`, a sink that loads
 * by URL on its own its URL from `useAssetUrl`.
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

/**
 * The address of a SET of server assets a library fetches on its own, by
 * appending the rest of the path to it (`<base>/<locale>/data.json`,
 * `<base>/<sample>.ogg`): an emoji picker's data, a sampler's samples. Opaque
 * like {@link AssetPath}, for the same reason: its URL comes only from
 * `useAssetUrl` (`endpoints/web`), which answers `unavailable` where the route
 * needs a computer the transport lacks — a library's own `fetch` reaches the
 * page's server, never the subtree's.
 *
 * Built only by {@link assetBase}, from the GET endpoint serving its files.
 */
export interface AssetBase {
  readonly [assetBaseBrand]: true;
  /** The `/api/…` path prefix the files are served under, on their server. */
  readonly [ASSET_PATH]: string;
  /** The route's `needsMachine` — set when only the desktop app serves it. */
  readonly needsMachine: MachineFeature | null;
}

/**
 * The {@link AssetBase} of `endpoint`'s files under its leading `params`: the
 * route's path, interpolated, cut before its first param not given
 * (`GET /api/asset-mirror/:id/:file` with `{ id: "emojibase" }` →
 * `/api/asset-mirror/emojibase`). Throws for a param given after one left
 * open (it would be cut away), and when nothing is left open — a whole path
 * is an {@link AssetPath}.
 */
export function assetBase<TParams>(
  endpoint: AssetEndpoint<TParams, unknown>,
  params: Partial<TParams>,
): AssetBase {
  const given = (params ?? {}) as Record<string, string>;
  const open = /\/:([A-Za-z_][\w]*)/g;
  let cut = -1;
  for (const m of endpoint.path.matchAll(open)) {
    if (!(m[1]! in given)) {
      cut = m.index;
      break;
    }
  }
  if (cut < 0) {
    throw new Error(
      `assetBase(${endpoint.route}): every param is given — a whole path is an AssetPath (assetPath)`,
    );
  }
  const prefix = endpoint.path.slice(0, cut);
  for (const name of Object.keys(given)) {
    if (!new RegExp(`:${name}(?!\\w)`).test(prefix)) {
      throw new Error(
        `assetBase(${endpoint.route}): param "${name}" comes after a param left open, so the base would drop it`,
      );
    }
  }
  return {
    [ASSET_PATH]: interpolatePath(prefix, given),
    needsMachine: endpoint.needsMachine ?? null,
  } as AssetBase;
}

declare const contentPathBrand: unique symbol;

/**
 * The address of a piece of untrusted CONTENT a frame shows — a document an
 * `access: { content }` route serves (an agent-written prototype). Opaque like
 * {@link AssetPath}; its URL comes only from `contentUrlOver`
 * (`endpoints/web`), which puts it on the content host
 * (`<item>.content.localhost`), never on an app origin. Framed only by
 * `ContentFrame` (`primitives/embed/frame`).
 *
 * Built only by {@link contentPath}, from the route's own declaration: `item`
 * — the content's origin key, one origin per piece of content — is the value
 * of the param the declaration names, never chosen by a caller.
 */
export interface ContentPath {
  readonly [contentPathBrand]: true;
  /** The `/api/…` path (and query) the content is served at. */
  readonly [ASSET_PATH]: string;
  /** The content's origin key (a DNS label). */
  readonly item: string;
  /** The route's `needsMachine` — set when only the desktop app serves it. */
  readonly needsMachine: MachineFeature | null;
}

/**
 * The {@link ContentPath} of what a content `endpoint` serves for `params`
 * (and `query`). Throws for an endpoint not declared `access: { content }`.
 */
export function contentPath<TParams, TQuery>(
  endpoint: AssetEndpoint<TParams, TQuery>,
  params: TParams,
  ...query: [TQuery] extends [void] ? [] : [query: TQuery]
): ContentPath {
  const access = endpoint.access;
  if (typeof access !== "object" || !("content" in access)) {
    throw new Error(
      `contentPath(${endpoint.route}): not a content route — declare access: { content, item }`,
    );
  }
  const item = (params as Record<string, string>)[access.item];
  if (item === undefined) {
    throw new Error(
      `contentPath(${endpoint.route}): no value for its item param "${access.item}"`,
    );
  }
  const asset = assetPath(endpoint, params, ...query);
  return {
    [ASSET_PATH]: asset[ASSET_PATH],
    item: item.toLowerCase(),
    needsMachine: asset.needsMachine,
  } as ContentPath;
}
