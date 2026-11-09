import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  Presence,
  type PresenceProps,
  type PresenceChild,
} from "./internal/presence";
export { useSizeMotion } from "./internal/size-motion";
export { useFlowMotion } from "./internal/flow-motion";
export { useEnterMotion } from "./internal/enter";
export { prefersReducedMotion } from "./internal/reduced-motion";
export {
  Arrival,
  type ArrivalProps,
  type ArrivalStep,
} from "./internal/arrival";

export default {
  description:
    "How floating surfaces move: <Presence> keeps a leaving surface drawn until its exit has run (and cross-fades a keyed swap), useSizeMotion tweens a surface's size when its content changes, useFlowMotion fades a newly shown in-flow item in and glides the siblings it displaces, useEnterMotion fades in an element its owner places itself (a canvas frame) when it arrives, prefersReducedMotion, <Arrival> eases a row that arrives while the reader watches into a flow of rows (slot opens, row fades in) — plus the no-unanimated-surface-exit lint rule.",
  contributions: [],
} satisfies PluginDefinition;
