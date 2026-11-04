import {
  useTransport,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import { allowAssetRoute } from "@plugins/primitives/plugins/networking/plugins/request-guard/web";
import type { AssetBase, AssetPath } from "../../core";
// `ASSET_PATH`: with asset-src.ts and frame-url.ts, this module is the one reader of an asset's path.
import { ASSET_PATH, unavailableMessage } from "../../core";

/**
 * The URL a sink that loads BY URL ON ITS OWN is handed — a library's own
 * `fetch` it offers no hook for (an emoji picker's data), an `<img src>` inside
 * an HTML string, an `<iframe>` whose relative sub-resources must resolve
 * against it:
 * - `ready` — `url` is the asset's path, on a server reachable by URL;
 * - `unavailable` — the route needs the computer and none is behind the
 *   transport (`message` says so in the one sentence every surface uses);
 * - `fetch-only` — the transport serves the route, but no URL reaches it (an
 *   in-browser server): only its own `fetch` does. A library that takes a
 *   fetch hook loads it through {@link assetFetchOver}; a sink that cannot
 *   says it is not available here.
 */
export type AssetUrl =
  | { readonly kind: "ready"; readonly url: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "fetch-only" };

/**
 * {@link AssetUrl} of `asset` on `transport`. Unlike `useAssetSrc` there is no
 * blob fallback — the sink fetches the URL itself, so it reaches the page's own
 * server whatever the subtree's transport. A desktop-only route therefore
 * answers `unavailable` on a transport without the computer, and a portable
 * route on a transport no URL reaches `fetch-only` — never a URL that would
 * silently load from the page's server.
 *
 * A ready URL's route is registered with the page request guard
 * (`allowAssetRoute`): the sink's own GET / HEAD of it is an asset load, not a
 * raw read of the app's API.
 */
export function assetUrlOver(
  transport: Transport,
  asset: AssetPath | AssetBase,
): AssetUrl {
  if (asset.needsMachine !== null && !transport.machine) {
    return {
      kind: "unavailable",
      message: unavailableMessage(asset.needsMachine),
    };
  }
  if (!transport.servesUrls) return FETCH_ONLY;
  const url = asset[ASSET_PATH];
  allowAssetRoute(url);
  return { kind: "ready", url };
}

const FETCH_ONLY: AssetUrl = Object.freeze({ kind: "fetch-only" });

/**
 * What a library that fetches `<base>/<file>` ITSELF, through a fetch hook it
 * accepts (a sampler's storage), is handed for `asset`:
 * - `ready` — `base` is the asset's path, and `fetch` loads a URL under it over
 *   the transport: the page's own server, or an in-browser server's answer;
 * - `unavailable` — the route needs the computer and none is behind the
 *   transport.
 *
 * `fetch` refuses (rejects) a URL outside `base`: the hook is this asset's, not
 * a general way to the app's API.
 */
export type AssetFetch =
  | {
      readonly kind: "ready";
      readonly base: string;
      readonly fetch: (url: string) => Promise<Response>;
    }
  | { readonly kind: "unavailable"; readonly message: string };

/** {@link AssetFetch} of `asset` on `transport`. */
export function assetFetchOver(
  transport: Transport,
  asset: AssetPath | AssetBase,
): AssetFetch {
  if (asset.needsMachine !== null && !transport.machine) {
    return {
      kind: "unavailable",
      message: unavailableMessage(asset.needsMachine),
    };
  }
  const base = asset[ASSET_PATH];
  // Its GETs are asset loads, not raw reads of the app's API.
  allowAssetRoute(base);
  return {
    kind: "ready",
    base,
    fetch: async (url) => {
      if (url !== base && !url.startsWith(`${base}/`)) {
        throw new Error(
          `assetFetchOver("${base}"): "${url}" is not under this asset's path`,
        );
      }
      return await transport.fetch(url);
    },
  };
}

/** {@link assetUrlOver} over the subtree's transport. */
export function useAssetUrl(asset: AssetPath | AssetBase): AssetUrl {
  return assetUrlOver(useTransport(), asset);
}
