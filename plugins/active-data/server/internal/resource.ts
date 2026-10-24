import { asc, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { activeDataBindings } from "../../core/resource";
import { _activeDataBindings } from "./tables";

// Push over `active_data_bindings`: the declared `reads` name the table, so the
// change feed recomputes (and pushes) the tuple on every PUT / DELETE of a
// binding — the routes notify nothing.
export const activeDataBindingsServed = serveValue(activeDataBindings, {
  source: "db",
  reads: {
    tables: [_activeDataBindings],
    reason:
      "a write to any binding row may change the bindings of the conversation it belongs to; whole-table until it reads through a collection",
  },
  loader: async ({ conversationId }) =>
    db
      .select({
        messageId: _activeDataBindings.messageId,
        tag: _activeDataBindings.tag,
        occurrenceIndex: _activeDataBindings.occurrenceIndex,
        payload: _activeDataBindings.payload,
      })
      .from(_activeDataBindings)
      .where(eq(_activeDataBindings.conversationId, conversationId))
      .orderBy(
        asc(_activeDataBindings.messageId),
        asc(_activeDataBindings.tag),
        asc(_activeDataBindings.occurrenceIndex),
      ),
});
