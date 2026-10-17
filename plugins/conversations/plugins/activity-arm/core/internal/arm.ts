import { liveArm } from "@plugins/network/plugins/live/core";
import { activity } from "@plugins/activity/core";
import { conversationsEntityRef } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * Conversations, as an arm of the activity space: its status, model and kind
 * picked from the entity (with the entity's labels), and every field a plugin
 * exposes on a conversation (its cost, tokens, agents) in its band.
 */
export const conversationActivityArm = liveArm(activity, "conversation", {
  label: "Conversation",
  order: 20,
  from: conversationsEntityRef,
  pick: ["status", "model", "kind"],
  sortable: ["status"],
});
