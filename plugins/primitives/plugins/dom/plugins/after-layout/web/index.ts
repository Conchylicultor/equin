import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  afterLayout,
  runAsAfterLayout,
  type AfterLayoutRead,
} from "./internal/after-layout";

export default {
  description:
    "Read layout where the browser already computed it: afterLayout(read) runs `read` once the current frame is styled and laid out, before it paints (a ResizeObserver delivery), batched with every other read of that frame — reads first, then the writes they return, then one React commit (flushSync) — so a layout or style read never forces a synchronous recalc on React's commit path, and a write never sits between two reads. runAsAfterLayout(fn) lets a ResizeObserver callback join the phase. element-size and layout-host read through it.",
  contributions: [],
} satisfies PluginDefinition;
