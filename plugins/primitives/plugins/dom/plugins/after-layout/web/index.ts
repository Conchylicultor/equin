import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  afterLayout,
  observeInPhase,
  runAsAfterLayout,
  type AfterLayoutRead,
} from "./internal/after-layout";

export default {
  description:
    "Read layout where the browser already computed it: afterLayout(read) runs `read` once the current frame is styled and laid out, before it paints (a ResizeObserver delivery), batched with every other read of that frame — reads first, then the writes they return, then one React commit (flushSync) — so a layout or style read never forces a synchronous recalc on React's commit path, and a write never sits between two reads. runAsAfterLayout(fn, delivered) lets a ResizeObserver callback join the phase; observeInPhase(observer, el) starts an observation where the browser can deliver it — at once, or (a target the running delivery can no longer reach) at the next frame, never a 'ResizeObserver loop' — and arms the root trigger with one started outside a phase, so its first callback shares the root's broadcast. element-size and layout-host read through it.",
  contributions: [],
} satisfies PluginDefinition;
