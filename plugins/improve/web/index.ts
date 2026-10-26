import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { ImproveButton } from "./components/improve-button";
import { ImproveSlots } from "./slots";

export { insertIntoImproveDraft, openImprove } from "./internal/open-store";
export { ImproveSlots } from "./slots";
export type {
  ImproveHeaderActionContribution,
  ImproveHeaderActionProps,
  ImproveSegmentContribution,
} from "./slots";

export default {
  description:
    'The Wish toolbar button: the entry point for anything the user wants done — a fix, a change, a new app. Files a task under "Improvements" with the current URL. Companion actions join it as segments of one split pill via ImproveSlots.Segment; ImproveSlots.HeaderAction adds actions to its popover header (Ask equin).',
  contributions: [
    ActionBar.Item({
      id: "improve",
      component: ImproveButton,
    }),
  ],
  slots: ImproveSlots,
} satisfies PluginDefinition;
