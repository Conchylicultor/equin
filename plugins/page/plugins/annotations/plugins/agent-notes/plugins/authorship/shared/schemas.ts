import { z } from "zod";
import type { FieldsRecord } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { compositeKey } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { liveCollection } from "@plugins/network/plugins/live/core";

// One authorship record: a conversation that wrote into an agent-notes card,
// and when it first did. `conversationId` may DANGLE — the record outlives the
// conversation row on purpose (see the table's comment) — so a reader must
// tolerate an id that resolves to nothing.
export const agentNotesAuthorFields = {
  blockId: textField(),
  conversationId: textField(),
  createdAt: dateField(),
} satisfies FieldsRecord;

/** The `page_blocks_agent_authors` entity — one field record for the table and the wire. */
export const agentNotesAuthorsEntityRef = entityRef(
  "page_blocks_agent_authors",
  agentNotesAuthorFields,
);

// The authors of ONE agent-notes card, oldest-first: a scoped whole set
// (`all: { by: ["blockId"] }`), one tuple per card, keyed by the table's
// composite primary key `(block_id, conversation_id)` — so a stamp on another
// card reaches no tuple (the router skips it on the carried `block_id`) and a
// stamp on this card is a one-row refill shipped as a keyed delta.
//
// The order is TOTAL (`conversationId` breaks a `createdAt` tie): the first
// record IS the card's creator (`useAgentNotesCreator`).
//
// Bounded by construction: only a MOUNTED card subscribes, and each tuple is
// that one card's handful of authors. Never preloaded (a scoped set has no
// default tuple): the anchor mounts route-scoped with the page.
//
// The key is NEW (`agent-notes-authors.v2`; it was the param'd value
// `agent-notes-authors`): a tab still on a bundle that subscribed the old key
// gets `unknown-key` — a `skew` verdict, the Reload prompt — instead of
// parsing keyed deltas its value read cannot apply (C39). Pinned by
// `../web/__tests__/agent-notes-authors-old-tab.test.ts`.
export const agentNotesAuthors = liveCollection("agent-notes-authors.v2", {
  from: agentNotesAuthorsEntityRef,
  carry: { pick: ["blockId", "conversationId", "createdAt"] },
  id: compositeKey(["blockId", "conversationId"]),
  all: {
    by: ["blockId"],
    orderBy: [
      ["createdAt", "asc"],
      ["conversationId", "asc"],
    ],
    unbounded: {
      reason:
        "one card's authors — the conversations that wrote into one block",
    },
  },
});

/** A row as `agentNotesAuthors` delivers it. */
export const AgentNotesAuthorSchema = agentNotesAuthors.row;
export type AgentNotesAuthor = z.infer<typeof AgentNotesAuthorSchema>;
