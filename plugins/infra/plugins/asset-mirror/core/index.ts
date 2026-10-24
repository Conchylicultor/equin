/**
 * `@plugins/infra/plugins/asset-mirror/core` — public, browser-safe surface.
 *
 * The asset-mirror primitive lazily mirrors a remote asset source to local disk
 * and serves it same-origin (offline-capable after one warm-up). This barrel
 * exposes the mirror's route declarations and the base web code points a
 * consumer at (`assetMirrorBase`, resolved with `useAssetUrl`); the server
 * barrel owns `defineAssetMirror` (the registration token), the machine
 * barrel the route.
 */

export {
  assetMirrorBase,
  getMirroredFile,
  getMirroredNestedFile,
} from "./endpoints";
export { assetMirrorUrl } from "./url";
export { assetMirrorPrewarmCollectedDir } from "./collected-dir";
export { defineAssetMirrorPrewarm } from "./prewarm";
export type { AssetMirrorPrewarm } from "./prewarm";
export { prewarmEntries } from "./prewarm.generated";
export type { CollectedEntry } from "./prewarm.generated";
