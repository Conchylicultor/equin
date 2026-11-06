import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { lazyComponent, useLazyReady } from "./internal/lazy-component";
export type { LazyComponentOptions } from "./internal/lazy-component";

export default {
  description:
    "Pairs React.lazy with its own Suspense boundary so a heavy component is code-split off the eager plugin-boot wave, loading on first mount instead.",
  contributions: [],
} satisfies PluginDefinition;
