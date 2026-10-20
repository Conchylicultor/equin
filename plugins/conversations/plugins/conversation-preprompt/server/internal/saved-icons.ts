import { isNotNull, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineSavedIconSource } from "@plugins/ui/plugins/icons/plugins/saved-sources/server";
import { SavedSymbolNameSchema } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import {
  nullable,
  parsed,
} from "@plugins/database/plugins/sql-projection/server";
import { _conversationPrepromptTable, conversationPreprompt } from "./tables";

const iconExpr = sql`${_conversationPrepromptTable.icon} ->> 'icon'`.mapWith(
  nullable(parsed(SavedSymbolNameSchema, "saved-icons.icon")),
);

/**
 * Every launch snapshot's preprompt icon — which outlives the preprompt it was
 * copied from — so the conversation chips draw at first paint.
 */
export const prepromptSnapshotIconsSource = defineSavedIconSource({
  id: "conversation-preprompt.snapshots",
  tables: [conversationPreprompt],
  names: async () =>
    (
      await db
        .selectDistinct({ icon: iconExpr })
        .from(_conversationPrepromptTable)
        .where(isNotNull(iconExpr))
    ).flatMap((r) => (r.icon === null ? [] : [r.icon])),
});
