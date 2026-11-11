import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";

export const WebsiteVision = {
  /**
   * Sections of the vision page at `/about/vision`, rendered
   * top-to-bottom below the page's heading. Each section owns its full-width
   * band.
   *
   * The page ships none of its own: the vision for applications is written as
   * contributions here, so writing it costs a new plugin rather than an edit to
   * this one.
   */
  Section: defineRenderSlot<{ label: string; component: ComponentType }>({
    docLabel: (p) => p.label,
  }),
};
