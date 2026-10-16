import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _blocks, liveBlocks } from "@plugins/page/plugins/editor/server";
import { defineSavedIconSource } from "@plugins/ui/plugins/icons/plugins/sprites/server";
import { SavedSymbolNameSchema } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import {
  nullable,
  parsed,
} from "@plugins/database/plugins/sql-projection/server";
import { calloutBlock } from "../../core";

const iconExpr = sql`${liveBlocks.data} ->> 'icon'`.mapWith(
  nullable(parsed(SavedSymbolNameSchema, "saved-icons.icon")),
);

/** Every live callout's saved icon, so callouts are drawable at first paint. */
export const calloutIconsSource = defineSavedIconSource({
  id: "page.callout-icons",
  tables: [_blocks],
  names: async () =>
    (
      await db
        .selectDistinct({ icon: iconExpr })
        .from(liveBlocks)
        .where(and(eq(liveBlocks.type, calloutBlock.type), isNotNull(iconExpr)))
    ).flatMap((r) => (r.icon === null ? [] : [r.icon])),
});
