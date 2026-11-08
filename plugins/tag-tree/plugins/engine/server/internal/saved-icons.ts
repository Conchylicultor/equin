import { isNotNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { parseSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { defineSavedIconSource } from "@plugins/ui/plugins/icons/plugins/saved-sources/server";
import type { TagTreeTableHandle } from "./serve";

/**
 * Every icon a tree's tags wear, so a tag's icon (and a carrier drawing its
 * tag's — a Places pin) is drawable at first paint. One source per served
 * tree, registered by `serveTagTree`.
 */
export function defineTagTreeIconSource(
  treeId: string,
  table: TagTreeTableHandle,
): void {
  defineSavedIconSource({
    code: import.meta,
    id: `tag-tree.${treeId}`,
    kind: "tables",
    tables: [table],
    names: async () =>
      (
        await db
          .selectDistinct({ icon: table.icon })
          .from(table)
          .where(isNotNull(table.icon))
      ).map((r) => parseSavedSymbolName(String(r.icon))),
  });
}
