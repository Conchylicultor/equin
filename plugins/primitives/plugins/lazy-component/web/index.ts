import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  HoldLazyMount,
  lazyComponent,
  useLazyReady,
} from "./internal/lazy-component";
export type { LazyComponentOptions } from "./internal/lazy-component";

export default {
  description:
    "Pairs React.lazy with its own Suspense boundary so a heavy component is code-split off the eager plugin-boot wave, loading on first mount instead. HoldLazyMount: under it, a lazy component mounting by a deferred render (a pane navigation) suspends that render instead of drawing its fallback, so the previous screen stays until its chunk is in.",
  contributions: [],
} satisfies PluginDefinition;
