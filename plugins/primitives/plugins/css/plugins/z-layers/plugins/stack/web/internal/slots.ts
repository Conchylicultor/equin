import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { defineOrderedSlot } from "@plugins/primitives/plugins/slot-render/web";

/** One top-level surface's place on the stack. */
export interface ZStackLayerDef {
  /** Unique across every plugin: the handle carries only this id. */
  id: string;
  /** What the surface is, as the order file's legend shows it. */
  label: string;
}

/**
 * The top-layer stack — the open set of app-wide surfaces that paint above the
 * popover layer (hint tips, the Ask card, the draw overlay, toasts…).
 *
 * A surface declares its layer in its OWN plugin and contributes it; the order
 * of all of them is this slot's reorder layout, one committed file. z-layers
 * never names a contributor, and a new layer cannot be pushed unplaced (it
 * shifts the layout's origin hash → `// @review` → the config checks fail).
 */
export const ZStack = {
  Layer: defineOrderedSlot<ZStackLayerDef>({
    docLabel: (c) => c.label,
    // Page-wide: one stack for the whole page — a host inside a scoped subtree
    // (an embedded app) must still see every layer, or its index would shift.
    pageWide: true,
  }),
};

/**
 * A declared layer: the handle its host stacks with, and the contribution its
 * plugin's barrel lists (`contributions: [AskLayer.contribution]`).
 */
export interface ZStackLayer extends ZStackLayerDef {
  readonly contribution: Contribution;
}

/** Declare a layer on the top-layer stack — in the plugin that draws it. */
export function defineZLayer(def: ZStackLayerDef): ZStackLayer {
  return { ...def, contribution: ZStack.Layer(def) };
}
