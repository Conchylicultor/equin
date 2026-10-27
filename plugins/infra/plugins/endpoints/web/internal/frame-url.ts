import type { Transport } from "@plugins/primitives/plugins/networking/web";
import type { AssetBase, AssetPath } from "../../core";
// `ASSET_PATH`: with asset-src.ts and asset-url.ts, this module is the one reader of an asset's path.
import { ASSET_PATH, unavailableMessage } from "../../core";

/**
 * The URL a FRAME document (`<iframe src>`) loads an asset at — a navigated
 * document whose relative sub-resources resolve beside it, served apart from
 * the page's own elements (`Transport.frameBase`):
 * - `ready` — `url` is the asset's path behind the transport's frame base;
 * - `unavailable` — the route needs the computer and none is behind the
 *   transport (`message` says so in the one sentence every surface uses);
 * - `unsupported` — nothing serves this transport's documents by URL here (an
 *   in-browser server in a browser without a Service Worker).
 */
export type FrameUrl =
  | { readonly kind: "ready"; readonly url: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "unsupported"; readonly message: string };

/** What a frame shows where nothing serves its document by URL. */
const UNSUPPORTED_MESSAGE =
  "This browser can't show live pages here — it needs Service Workers, which this window doesn't offer (a private window, or an insecure address).";

/**
 * {@link FrameUrl} of `asset` on `transport`. Never for an element of the page
 * itself (an `<img>` loads through `useAssetSrc`, a sink loading by URL
 * through `assetUrlOver`): only a frame document is served under the frame
 * base.
 */
export function frameUrlOver(
  transport: Transport,
  asset: AssetPath | AssetBase,
): FrameUrl {
  if (asset.needsMachine !== null && !transport.machine) {
    return {
      kind: "unavailable",
      message: unavailableMessage(asset.needsMachine),
    };
  }
  if (transport.frameBase === null) {
    return { kind: "unsupported", message: UNSUPPORTED_MESSAGE };
  }
  return { kind: "ready", url: `${transport.frameBase}${asset[ASSET_PATH]}` };
}
