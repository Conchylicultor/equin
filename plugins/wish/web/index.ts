import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { PhoneActions } from "@plugins/apps-core/plugins/phone-actions/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { WishButton } from "./components/wish-button";
import { WishSheet } from "./components/wish-sheet";
import { WishSlots } from "./slots";

export { insertIntoWishDraft, openWish } from "./internal/open-store";
export { WishSlots } from "./slots";
export { WishField } from "./components/wish-field";
export type {
  WishHeaderActionContribution,
  WishHeaderActionProps,
  WishSegmentContribution,
} from "./slots";

export default {
  description:
    'The Wish toolbar button: the entry point for anything the user wants done — a fix, a change, a new app. Files a task under "Wishes" with the current URL. Companion actions join it as segments of one split pill via WishSlots.Segment; WishSlots.HeaderAction adds actions to its popover header (Ask equin). WishField is the same wish as a companion’s section — the task composer with its own ↑, filing one task under Wishes about the page the DraftPage around it names, confirming inline (“Filed — an agent is on …”). On a phone the same field is the Wish sheet of the phone action button (PhoneActions.Action “wish”).',
  contributions: [
    ActionBar.Item({
      id: "improve",
      component: WishButton,
    }),
    PhoneActions.Action({
      id: "wish",
      label: "Wish",
      icon: symbol("flare"),
      component: WishSheet,
    }),
  ],
  slots: WishSlots,
} satisfies PluginDefinition;
