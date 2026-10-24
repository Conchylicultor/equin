import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

// One authorship record: a conversation that wrote into an agent-notes card,
// and when it first did. `conversationId` may DANGLE — the record outlives the
// conversation row on purpose (see the table's comment) — so a reader must
// tolerate an id that resolves to nothing.
export const AgentNotesAuthorSchema = z.object({
  blockId: z.string(),
  conversationId: z.string(),
  createdAt: z.coerce.date(),
});
export type AgentNotesAuthor = z.infer<typeof AgentNotesAuthorSchema>;

// The authors of ONE agent-notes card, oldest-first — a value per `{ blockId }`,
// pushed whole in the loader's order.
//
// Bounded by construction: only a MOUNTED card subscribes, and each tuple is
// that one card's handful of authors — it never grows with the table. A value
// rather than a collection: the table's key is the composite
// `(block_id, conversation_id)`, so there is no single row id to look rows up
// by (migration contract §10).
//
// NOT preloaded (a param'd value has no default tuple): the anchor mounts
// route-scoped with the page, so it hydrates post-mount via its sub-ack — same
// call `prompt-block-tasks` makes.
export const agentNotesAuthors = liveValue("agent-notes-authors", {
  schema: wholeList(AgentNotesAuthorSchema, {
    reason: "one card's authors — the conversations that wrote into one block",
  }),
  params: ["blockId"],
});
