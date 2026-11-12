import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";

export const WebsiteStory = {
  /**
   * Sections of the story page at `/about/story`, rendered top-to-bottom below
   * the page's opening. Each section owns its full-width band (compose
   * `WebsiteBand`).
   *
   * The page ships none of its own: the story is written as contributions
   * here (`story/essay`), so writing more costs a new plugin rather than an
   * edit to this one.
   */
  Section: defineRenderSlot<{ label: string; component: ComponentType }>({
    docLabel: (p) => p.label,
  }),
};
