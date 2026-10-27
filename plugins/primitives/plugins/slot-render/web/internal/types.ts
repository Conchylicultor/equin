import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { ComponentType, ReactNode } from "react";

/**
 * `depth` is the middleware's place in the wrapping chain, not a position among
 * siblings: the lowest depth wraps outermost, every higher one nests inside it.
 */
export interface SlotItemMiddleware {
  /** Wrapping depth: lower wraps outside higher (the error boundary is deepest). */
  depth: number;
  Component: ComponentType<{
    slotId: string;
    contribution: Contribution;
    children: ReactNode;
  }>;
}

export interface SlotListMiddleware {
  /** Wrapping depth around the whole list: lower wraps outside higher. */
  depth: number;
  Component: ComponentType<{
    slotId: string;
    /** The slot's own description (kind, `partOfComponent`, …). */
    slotMeta: SlotHandle["meta"];
    contributions: readonly Contribution[];
    renderItem: (contribution: Contribution) => ReactNode;
    children: ReactNode;
  }>;
}

/**
 * How a reorderable slot's contributions are ordered for a host that draws
 * them itself (`useSlotOrder`): the data-level twin of the list middleware —
 * the same layout, no rendering. Contributed by the plugin that owns layouts
 * (reorder's slot-middleware, a companion), so a host names no layout engine.
 * The hook returns the contributions to draw, in order (hidden ones dropped),
 * as a read: `loading` while the slot's layout is not known yet, never the raw
 * registration order standing in for it (that would show hidden items and then
 * jump). The error arm carries the last-known layout as `stale` when there was
 * one, and never the raw order when there was not.
 */
export interface SlotOrder {
  useOrder: Hook<
    (
      slot: SlotHandle,
      contributions: readonly Contribution[],
    ) => ResourceResult<readonly Contribution[]>
  >;
}

/** What the box being stamped is, for a {@link SlotItemAttrsFn}. */
export interface SlotItemBox {
  slotId: string;
  contribution: Contribution;
  /**
   * True when the box generates no box of its own (`display:contents`) — it is
   * in the DOM but there is nothing to point at and no layout it owns. A
   * describing consumer usually wants to say so, since walks that look for the
   * nearest *authored* element must skip it.
   */
  boxless: boolean;
}

/**
 * DOM attributes to stamp onto one contribution's box. Return `null` for
 * nothing.
 *
 * MUST be pure and cheap: it runs during render, once per contribution.
 */
export type SlotItemAttrsFn = (
  box: SlotItemBox,
) => Record<string, string | undefined> | null;
