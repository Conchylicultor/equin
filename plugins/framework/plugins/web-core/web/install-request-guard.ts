/**
 * Installs the page request guard (`primitives/networking/plugins/request-guard`)
 * — imported FIRST by `main.tsx`, as a side effect, so it runs before the rest
 * of the entry's static import graph (`App` and every plugin it pulls in)
 * evaluates. A call in `main.tsx`'s own body would run after all of it.
 *
 * The asset mirror's prefix is registered here once: Sonata's samplers load
 * their samples from it by URL with no transport to resolve an asset base over
 * (`assetMirrorUrl`). Every other asset route a sink loads by URL is
 * registered as `assetUrlOver` hands its URL out.
 */
import {
  allowAssetRoute,
  installRequestGuard,
} from "@plugins/primitives/plugins/networking/plugins/request-guard/web";
import { ASSET_MIRROR_PREFIX } from "@plugins/infra/plugins/asset-mirror/core";

installRequestGuard();
allowAssetRoute(ASSET_MIRROR_PREFIX);
