import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";

export const WebsiteGuide = {
  /**
   * Sections of the guide at `/about/guide`, rendered top-to-bottom below the
   * page's heading. Each section owns its full-width band (compose
   * `WebsiteBand`).
   *
   * The page ships none of its own: the first tasks, agents and changes are
   * written as contributions here, so writing the guide costs a new plugin
   * rather than an edit to this one.
   */
  Section: defineRenderSlot<{ label: string; component: ComponentType }>({
    docLabel: (p) => p.label,
  }),
};
