import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SlotRender } from "@plugins/primitives/plugins/slot-render/web";
import { ReorderListMiddleware, useLayoutOrder } from "@plugins/reorder/web";

export default {
  description:
    "Applies every render slot's committed layout: reorder's list middleware, contributed to slot-render as a companion so it ships wherever slots render.",
  loadBearing: true,
  // A companion, not an option: without it every slot silently renders in raw
  // registration order and ignores its `config/**/<slot>.jsonc` layout. Its own
  // plugin rather than reorder's barrel, whose `contributions` is the live
  // array the declaration pass rewrites — a companion must sit in an inline
  // literal for the closure engine to read it. Importing reorder pulls it in.
  contributions: [
    SlotRender.ListMiddleware({
      depth: 0,
      Component: ReorderListMiddleware,
      companion: true,
    }),
    // The same layout, for a host that draws a slot's contributions itself
    // (`useSlotOrder`).
    SlotRender.Order({ useOrder: useLayoutOrder, companion: true }),
  ],
} satisfies PluginDefinition;
