import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type {
  SlotItemAttrsFn,
  SlotItemMiddleware,
  SlotListMiddleware,
} from "./types";

/**
 * What every slot renders through, contributed by the plugins that shape it.
 *
 * Declared slots rather than a module-level registry, so the dependency is
 * visible: a plugin that registered imperatively was reachable from nothing,
 * and `reorder` — which applies every slot's committed layout — dropped out of
 * served bundles that way (every slot silently fell back to registration
 * order). All three accept companions: a contribution every slot needs
 * (error isolation, layouts) says `companion: true` and ships wherever
 * slot-render does; one that only describes or polishes (the element picker's
 * lineage marker) stays an opt-in option.
 */
export const SlotRender = {
  /** Wraps a render slot's whole contribution list (`.Render` only), lowest priority outermost. */
  ListMiddleware: defineSlot<SlotListMiddleware>({ companions: true }),
  /** Wraps each contribution `.Render` / `.Mount` / `.Dispatch` / `renderIsolated` draws, lowest priority outermost. */
  ItemMiddleware: defineSlot<SlotItemMiddleware>({ companions: true }),
  /**
   * DOM attributes stamped onto EVERY contribution's own box — the one element
   * a slot draws around each contribution.
   *
   * Data, not an element, on purpose. A plugin that wants to describe
   * contributions (the element picker's lineage marker) used to do it by
   * wrapping them, which meant it landed wherever its wrapper happened to sit —
   * and it sat inside the cell the slot draws, so the slack between a small
   * widget and the edge of its cell described nothing. Attributes cannot be
   * misplaced: there is exactly one box per contribution and the slot owns it.
   */
  ItemAttrs: defineSlot<{ attrs: SlotItemAttrsFn }>({ companions: true }),
};
