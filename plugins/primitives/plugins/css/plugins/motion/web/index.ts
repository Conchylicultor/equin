import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  Presence,
  type PresenceProps,
  type PresenceChild,
} from "./internal/presence";
export { useSizeMotion } from "./internal/size-motion";
export { prefersReducedMotion } from "./internal/reduced-motion";

export default {
  description:
    "How floating surfaces move: <Presence> keeps a leaving surface drawn until its exit has run (and cross-fades a keyed swap), useSizeMotion tweens a surface's size when its content changes, prefersReducedMotion — plus the no-unanimated-surface-exit lint rule.",
  contributions: [],
} satisfies PluginDefinition;
