import type { ComponentType } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";

export interface ImproveSegmentContribution {
  id: string;
  /**
   * One trailing segment of the Wish pill — a companion action that feeds
   * the same draft (the element picker). It renders ONE `<Button
   * variant="outline">` (or a trigger rendering one) as its root, with no
   * wrapper element: the pill is a `ButtonGroup`, which shapes its direct
   * children into segments.
   */
  component: ComponentType;
}

export interface ImproveHeaderActionProps {
  /** Close the Wish popover (its draft is kept). */
  close: () => void;
}

export interface ImproveHeaderActionContribution {
  id: string;
  /**
   * An action in the Wish popover's header, before its × — another entry point
   * for what the user came for (Ask equin, for a question rather than a task).
   * Renders one `IconButton`.
   */
  component: ComponentType<ImproveHeaderActionProps>;
}

/**
 * Improve's own extension point: segments joined to the Improve button as one
 * split pill (`[✦ Wish | ⌖]`). A plain slot rendered with `renderIsolated`
 * per contribution — NOT a render slot, whose row cells would wrap each
 * segment in an element and break the group's direct-child seams.
 */
export const ImproveSlots = {
  Segment: defineSlot<ImproveSegmentContribution>({
    docLabel: (p) => p.id,
  }),
  HeaderAction: defineSlot<ImproveHeaderActionContribution>({
    docLabel: (p) => p.id,
  }),
};
