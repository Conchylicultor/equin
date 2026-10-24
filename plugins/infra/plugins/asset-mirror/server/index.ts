import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { defineAssetMirror } from "./internal/registry";
export type { AssetMirrorSpec } from "./internal/registry";
export { runAssetMirrorPrewarm } from "./internal/run-prewarm";
export { seedAssetMirrorCache } from "./internal/seed-cache";

export default {
  description:
    "Generic server-side asset mirror: plugins declare a remote asset source via defineAssetMirror; files are lazily downloaded on first request, cached on local disk, and served same-origin thereafter (offline-capable after one warm-up). Its route is the machine/ half's.",
} satisfies ServerPluginDefinition;
