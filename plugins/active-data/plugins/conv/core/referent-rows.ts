import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  conversationsEntityRef,
  tasksEntityRef,
} from "@plugins/tasks/plugins/tasks-core/core";

// What a `conv-…` chip shows, by conversation id — its own title, else its
// task's. Lookup-only, a FOLLOW target: a live value showing stored text with
// its chips as their titles (a backlink's snippet) follows the conversations
// its text names (inline-chip's `followedReferent`). The row is exactly what
// `resolveConversationReferent` reads, so a status flip or a poller write
// reaches no follower; a retitle of the conversation or its task refills it.
export const conversationChipReferents = liveCollection(
  "conversation-chip.referents",
  {
    from: conversationsEntityRef,
    carry: {
      pick: ["id", "title"],
      fields: { taskTitle: tasksEntityRef.fields.title },
    },
    baseExposures: false,
    id: "id",
  },
);
