import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { ComponentType, ReactNode } from "react";

export interface SlotItemMiddleware {
  priority: number;
  Component: ComponentType<{
    slotId: string;
    contribution: Contribution;
    children: ReactNode;
  }>;
}

export interface SlotListMiddleware {
  priority: number;
  Component: ComponentType<{
    slotId: string;
    contributions: readonly Contribution[];
    renderItem: (contribution: Contribution) => ReactNode;
    children: ReactNode;
  }>;
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
