import { serveCollection } from "@plugins/network/plugins/live/server";
import { followedReferent } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
import {
  _conversations,
  conversationOwnerJoins,
} from "@plugins/tasks/plugins/tasks-core/server";
import { conversationChipReferents } from "../../core";
import { conversationReferentTitle } from "./referent";

/** `conversation-chip.referents` over `conversations`, its task's title through the owner joins. */
export const conversationChipReferentsServed = serveCollection(
  conversationChipReferents,
  {
    from: _conversations,
    joins: conversationOwnerJoins,
    columns: { taskTitle: (j) => j.task.title },
  },
);

/** A live value's read of a `conv-…` chip: the conversation's row, by the token itself. */
export const conversationChipLiveRead = followedReferent(
  conversationChipReferentsServed,
  {
    idOf: (token) => token,
    referentOf: (row) => ({
      found: true,
      title: conversationReferentTitle(row),
    }),
  },
);
