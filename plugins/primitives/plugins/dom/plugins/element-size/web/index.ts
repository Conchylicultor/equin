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
    "Element-size ResizeObserver idiom as a primitive: useElementSize() reactively measures an element's layout size (callback ref; the observer's own border-box size, so a transform never freezes a wrong value; its first delivery shares the after-layout root's broadcast, so the commit it makes may change layout at any depth), useResizeObserver(target, onResize, {debounce, deps}) is the substrate, and useResizeObserverSet(onResize) observes a changing set of elements (windowed rows) through one observer — initial measure after layout and before paint (dom/after-layout: no forced recalc on the commit path), RAF-debounced resize callbacks, every observation started through after-layout's observeInPhase (never held back into a 'ResizeObserver loop'), auto cleanup. The single sanctioned home for the hand-rolled ResizeObserver-for-size idiom.",
  contributions: [],
} satisfies PluginDefinition;
