import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  afterLayout,
  commitInPhase,
  observeInPhase,
  runAsAfterLayout,
  type AfterLayoutRead,
} from "./internal/after-layout";

export default {
  description:
    "Read layout where the browser already computed it: afterLayout(read) runs `read` once the current frame is styled and laid out, before it paints (a ResizeObserver delivery), batched with every other read of that frame — reads first, then the writes they return, then one React commit (flushSync) — so a layout or style read never forces a synchronous recalc on React's commit path, and a write never sits between two reads. runAsAfterLayout(fn, delivered) lets a ResizeObserver callback join the phase; commitInPhase(update) is its one way to commit before paint — whatever that commit resizes at or above the delivery (which the browser could only deliver a frame late, with a 'ResizeObserver loop' error) is answered in the same phase through the observer's onHeldBack, and its observation restarted at the next frame; observeInPhase(observer, el, onHeldBack?) starts and keeps an observation where the browser can deliver it — at once, or (a target the running delivery can no longer reach) at the next frame — and arms the root trigger with one started outside a phase, so its first callback shares the root's broadcast. element-size and layout-host read through it.",
  contributions: [],
} satisfies PluginDefinition;
