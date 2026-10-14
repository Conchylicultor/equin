import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { SkillListingView } from "./components/skill-listing-view";

export default {
  collapsed: true,
  description:
    "Renders skill-listing attachment events showing skills available in the current session.",
  contributions: [
    ...attachmentRenderer({
      match: "skill_listing",
      component: SkillListingView,
      role: "context",
    }),
  ],
} satisfies PluginDefinition;
