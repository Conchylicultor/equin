import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { WishButton } from "./components/wish-button";
import { WishSlots } from "./slots";

export { insertIntoWishDraft, openWish } from "./internal/open-store";
export { WishSlots } from "./slots";
export type {
  WishHeaderActionContribution,
  WishHeaderActionProps,
  WishSegmentContribution,
} from "./slots";

export default {
  description:
    'The Wish toolbar button: the entry point for anything the user wants done — a fix, a change, a new app. Files a task under "Wishes" with the current URL. Companion actions join it as segments of one split pill via WishSlots.Segment; WishSlots.HeaderAction adds actions to its popover header (Ask equin).',
  contributions: [
    ActionBar.Item({
      id: "improve",
      component: WishButton,
    }),
  ],
  slots: WishSlots,
} satisfies PluginDefinition;
