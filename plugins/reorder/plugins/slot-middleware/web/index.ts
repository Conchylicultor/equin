import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SlotRender } from "@plugins/primitives/plugins/slot-render/web";
import {
  ReorderItemMiddleware,
  ReorderListMiddleware,
} from "@plugins/reorder/web";

export default {
  description:
    "Applies every render slot's committed layout (and hosts its drag surface): reorder's list and item middleware, contributed to slot-render as companions so they ship wherever slots render.",
  loadBearing: true,
  // Companions, not options: without them every slot silently renders in raw
  // registration order and ignores its `config/**/<slot>.jsonc` layout. Their
  // own plugin rather than reorder's barrel, whose `contributions` is the live
  // array the declaration pass rewrites — a companion must sit in an inline
  // literal for the closure engine to read it. Importing reorder pulls it in.
  contributions: [
    SlotRender.ListMiddleware({
      priority: 0,
      Component: ReorderListMiddleware,
      companion: true,
    }),
    SlotRender.ItemMiddleware({
      priority: 50,
      Component: ReorderItemMiddleware,
      companion: true,
    }),
  ],
} satisfies PluginDefinition;
