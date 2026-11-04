import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { runAssetMirrorPrewarm } from "./internal/run-prewarm";
export { seedAssetMirrorCache } from "./internal/seed-cache";

export default {
  description:
    "The asset mirror's release bundle, host-only: runAssetMirrorPrewarm downloads every prewarm-declared file of a composition's closure into a release bundle, and seedAssetMirrorCache copies a bundle's files into a fresh install's mirror cache (copy-if-absent).",
} satisfies ServerPluginDefinition;
