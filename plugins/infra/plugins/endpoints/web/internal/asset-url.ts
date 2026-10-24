import {
  useTransport,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import type { AssetBase, AssetPath } from "../../core";
// `ASSET_PATH`: with asset-src.ts, this module is the one reader of an asset's path.
import { ASSET_PATH, unavailableMessage } from "../../core";

/**
 * The URL a sink that loads BY URL ON ITS OWN is handed — a library's own
 * `fetch` (an emoji picker's data, a sampler's samples), an `<img src>` inside
 * an HTML string, an `<iframe>` whose relative sub-resources must resolve
 * against it:
 * - `ready` — `url` is the asset's path, on a server reachable by URL;
 * - `unavailable` — the route needs the computer and none is behind the
 *   transport (`message` says so in the one sentence every surface uses).
 */
export type AssetUrl =
  | { readonly kind: "ready"; readonly url: string }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * {@link AssetUrl} of `asset` on `transport`. Unlike `useAssetSrc` there is no
 * blob fallback — the sink fetches the URL itself, so it reaches the page's own
 * server whatever the subtree's transport. A desktop-only route therefore
 * answers `unavailable` on a transport without the computer; a portable route
 * on a transport no URL reaches THROWS: that sink would silently load from the
 * page's server — load such an asset through `useAssetSrc`, or declare the
 * route `needsMachine`.
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
  if (!transport.servesUrls) {
    throw new Error(
      `assetUrlOver("${asset[ASSET_PATH]}"): this transport serves no URL (an in-browser server), so a sink loading by URL would reach the page's own server instead — load it through useAssetSrc, or declare its route needsMachine`,
    );
  }
  return { kind: "ready", url: asset[ASSET_PATH] };
}

/** {@link assetUrlOver} over the subtree's transport. */
export function useAssetUrl(asset: AssetPath | AssetBase): AssetUrl {
  return assetUrlOver(useTransport(), asset);
}
