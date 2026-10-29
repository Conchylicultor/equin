import { liveCollection } from "@plugins/network/plugins/live/core";
import { conversationSessionsEntityRef } from "./entity";

// One conversation's session chain, oldest → newest — a scoped `all` set
// (`all: { by: ["conversationId"] }`) FOLLOWED by
// `{ where: { conversationId } }` (network/live's `follows`,
// research/2026-10-24-global-live-narrowed-reads.md §4): the transcript
// family's values read the chain through it, so a session recorded on one
// conversation reaches only the followers of that conversation. Served over
// the `conversation_sessions` table (`conversationSessionsServed`,
// `../server`); no surface reads it over the wire today. The table is
// append-only, so an insert is the only write that reaches it.
export const conversationSessions = liveCollection("conversation-sessions", {
  from: conversationSessionsEntityRef,
  carry: { pick: ["id", "conversationId", "claudeSessionId", "seenAt"] },
  baseExposures: false,
  id: "id",
  all: {
    by: ["conversationId"],
    orderBy: [["seenAt", "asc"]],
    unbounded: {
      reason:
        "one conversation's session chain — a new id per fork or handoff, a handful each",
    },
  },
});
