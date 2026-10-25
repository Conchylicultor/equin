import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  useElementSize,
  useResizeObserver,
  useResizeObserverSet,
  type ElementSize,
  type ResizeTarget,
} from "./internal/element-size";

export default {
  description:
    "Element-size ResizeObserver idiom as a primitive: useElementSize(target?) reactively measures an element's size (callback ref, getBoundingClientRect, supports attach-one-node-measure-another via a target getter), useResizeObserver(target, onResize, {debounce, deps}) is the substrate, and useResizeObserverSet(onResize) observes a changing set of elements (windowed rows) through one observer — synchronous initial measure, RAF-debounced resize callbacks, auto cleanup. The single sanctioned home for the hand-rolled ResizeObserver-for-size idiom.",
  contributions: [],
} satisfies PluginDefinition;
