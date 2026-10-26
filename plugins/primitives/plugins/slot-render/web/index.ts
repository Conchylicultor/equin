import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SlotRender } from "./internal/slots";

export {
  defineRenderSlot,
  defineMountSlot,
  defineDispatchSlot,
  defineOrderedDispatchSlot,
  defineOrderedSlot,
  defineWrapperSlot,
  renderIsolated,
  renderAsContribution,
  RenderSlotSubIdContext,
} from "./internal/render-slot";
export type {
  RenderSlot,
  RenderSlotConfig,
  DerivedIdRenderSlot,
  MountSlot,
  MountComponent,
  MountSlotConfig,
  DispatchSlot,
  DispatchContribution,
  DispatchSlotConfig,
  OrderedDispatchSlot,
  OrderedDispatchContribution,
  OrderedContribution,
  WrapperSlot,
  WrapperSlotConfig,
  WrapContribution,
} from "./internal/render-slot";
export { RenderCoreRoot } from "./internal/root-render";
export { useSlotOrder } from "./internal/slot-order";
export { SlotItemLayout } from "./internal/item-layout";
export type { SlotItemOrientation } from "./internal/item-layout";
export { useDispatchOutcome } from "./internal/dispatch-outcome";
export type { DispatchOutcome } from "./internal/dispatch-outcome";
export type {
  SlotItemAttrsFn,
  SlotItemBox,
  SlotItemMiddleware,
  SlotListMiddleware,
  SlotOrder,
} from "./internal/types";
export { SlotRender } from "./internal/slots";

export default {
  description:
    "Typed rendering primitive for visual slots with auto-applied middleware (error boundaries, reorder).",
  loadBearing: true,
  contributions: [],
  slots: SlotRender,
} satisfies PluginDefinition;
