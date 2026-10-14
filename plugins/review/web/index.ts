import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { ReviewButton } from "./components/review-button";
import { convReviewPane } from "./panes";
import { Review } from "./slots";

export { Review as ReviewSlots } from "./slots";
export { convReviewPane } from "./panes";
export type { Source, ReviewProps } from "./source";

export default {
  description:
    "Toolbar button that opens a side pane exposing agent modifications in a structured, extensible view.",
  contributions: [
    Pane.Register({ pane: convReviewPane }),
    Conversation.ActionBar({
      id: "review",
      requires: ["git"],
      component: ReviewButton,
    }),
  ],
  slots: { ...Review, "conv-review": convReviewPane },
} satisfies PluginDefinition;
