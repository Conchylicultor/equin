/**
 * `@plugins/infra/plugins/asset-mirror/core` — public, browser-safe surface.
 *
 * The asset-mirror primitive lazily mirrors a remote asset source into a local
 * cache and serves it same-origin (offline-capable after one warm-up on the
 * desktop). This barrel exposes the mirror's route declarations and the base
 * web code points a consumer at (`assetMirrorBase`, resolved with
 * `assetFetchOver` or `useAssetUrl`; `assetMirrorFile`, one file an element
 * loads, resolved with `useAssetSrc`); the server barrel owns
 * `defineAssetMirror` (the registration token) and the route.
 */

export {
  assetMirrorBase,
  assetMirrorFile,
  getMirroredFile,
  getMirroredNestedFile,
} from "./endpoints";
export { assetMirrorPrewarmCollectedDir } from "./collected-dir";
export { defineAssetMirrorPrewarm } from "./prewarm";
export type { AssetMirrorPrewarm } from "./prewarm";
export { prewarmEntries } from "./prewarm.generated";
export type { CollectedEntry } from "./prewarm.generated";
